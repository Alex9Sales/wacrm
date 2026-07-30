// ============================================================
// Phase 2 — sector auto-routing for brand-new conversations.
//
// When the inbound pipeline opens a NEW conversation it calls
// routeNewConversation(). Precedence for choosing a sector:
//   1. Keyword match on the first message → that sector (most intent-specific).
//   2. Else the channel's default sector (`channels.default_sector_id`).
//   3. Else null → the general queue (visible to everyone).
//
// If the resolved sector has `auto_assign` on, the conversation is also
// assigned to the least-loaded handling member OF THAT SECTOR — writing
// assigned_agent_id fires the `notify_conversation_assigned` DB trigger so
// the agent is notified. The general queue (null sector) is never
// auto-assigned: anyone can pick it up.
// ============================================================

import { and, eq, isNotNull, inArray } from 'drizzle-orm';

import { db, conversations, channels, sectors, sectorMembers, member } from '@/db';
import { firstOrNull } from '@/db/helpers';

/** Roles that actually handle conversations (viewers are read-only). */
const HANDLING_ROLES = ['owner', 'admin', 'agent'];

export interface RouteResult {
  sectorId: string | null;
  assignedAgentId: string | null;
}

/** Normalize for accent/case-insensitive keyword matching. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

interface SectorRow {
  id: string;
  keywords: string[];
  autoAssign: boolean;
}
type Chosen = { id: string; autoAssign: boolean };

/** All sectors of an account, with their keywords + auto-assign flag. */
async function loadAccountSectors(accountId: string): Promise<SectorRow[]> {
  return db
    .select({
      id: sectors.id,
      keywords: sectors.keywords,
      autoAssign: sectors.autoAssign,
    })
    .from(sectors)
    .where(eq(sectors.accountId, accountId));
}

/** First sector whose keyword appears in `text` (accent/case-insensitive). */
function matchKeyword(accountSectors: SectorRow[], text: string): Chosen | null {
  const haystack = normalize(text || '');
  if (!haystack) return null;
  for (const s of accountSectors) {
    const kws = (s.keywords ?? []).map(normalize).filter(Boolean);
    if (kws.some((kw) => haystack.includes(kw))) {
      return { id: s.id, autoAssign: s.autoAssign };
    }
  }
  return null;
}

/** Persist the chosen sector on a conversation, auto-assigning when enabled. */
async function applySector(
  accountId: string,
  conversationId: string,
  chosen: Chosen,
): Promise<RouteResult> {
  const assignedAgentId = chosen.autoAssign
    ? await pickLeastLoadedSectorAgent(accountId, chosen.id)
    : null;

  await db
    .update(conversations)
    .set({
      sectorId: chosen.id,
      ...(assignedAgentId
        ? { assignedAgentId, assignedAt: new Date().toISOString() }
        : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(conversations.id, conversationId));

  return { sectorId: chosen.id, assignedAgentId };
}

/**
 * Resolve and persist the sector (and optional assignee) for a freshly
 * created conversation: keyword on the first message wins, else the channel's
 * default sector, else the general queue. Best-effort: any failure leaves the
 * conversation in the general queue rather than dropping the message.
 */
export async function routeNewConversation(params: {
  accountId: string;
  channelId: string | null;
  conversationId: string;
  firstText: string;
}): Promise<RouteResult> {
  const { accountId, channelId, conversationId, firstText } = params;
  try {
    const accountSectors = await loadAccountSectors(accountId);

    // 1) The channel's default sector wins — a dedicated number (ex.: cema tem
    // um número por setor) é AUTORITATIVO. Assim uma palavra-chave solta ("nota")
    // não joga a conversa desse número pra outro setor.
    let chosen: Chosen | null = null;
    if (channelId) {
      const ch = firstOrNull(
        await db
          .select({ defaultSectorId: channels.defaultSectorId })
          .from(channels)
          .where(eq(channels.id, channelId))
          .limit(1),
      );
      if (ch?.defaultSectorId) {
        const s = accountSectors.find((x) => x.id === ch.defaultSectorId);
        if (s) chosen = { id: s.id, autoAssign: s.autoAssign };
      }
    }

    // 2) Else (canal sem setor padrão — número compartilhado) a palavra-chave
    // da 1ª mensagem decide.
    if (!chosen) chosen = matchKeyword(accountSectors, firstText);

    // 3) Else the general queue.
    if (!chosen) return { sectorId: null, assignedAgentId: null };
    return await applySector(accountId, conversationId, chosen);
  } catch (err) {
    console.error('[routing] routeNewConversation failed:', err);
    return { sectorId: null, assignedAgentId: null };
  }
}

/**
 * Mid-conversation keyword re-route. The caller guarantees this fires ONLY
 * while a thread is still unclaimed (in the general queue and no HUMAN agent
 * has replied) — so a later "boleto" moves an unattended thread to Financeiro,
 * but a conversation a salesperson is already handling is never yanked away.
 * Keyword-only (no channel default): the channel already had its say at
 * creation. Best-effort; a no-match leaves the thread where it is.
 */
export async function rerouteByKeyword(params: {
  accountId: string;
  conversationId: string;
  text: string;
}): Promise<RouteResult> {
  const { accountId, conversationId, text } = params;
  try {
    const chosen = matchKeyword(await loadAccountSectors(accountId), text);
    if (!chosen) return { sectorId: null, assignedAgentId: null };
    return await applySector(accountId, conversationId, chosen);
  } catch (err) {
    console.error('[routing] rerouteByKeyword failed:', err);
    return { sectorId: null, assignedAgentId: null };
  }
}

/**
 * Pick the handling-role member of a sector with the fewest open assigned
 * conversations. Returns null when the sector has no eligible member.
 */
export async function pickLeastLoadedSectorAgent(
  accountId: string,
  sectorId: string,
): Promise<string | null> {
  // Members of the sector…
  const memberRows = await db
    .select({ userId: sectorMembers.userId })
    .from(sectorMembers)
    .where(eq(sectorMembers.sectorId, sectorId));
  const sectorUserIds = memberRows.map((r) => r.userId);
  if (sectorUserIds.length === 0) return null;

  // …restricted to handling roles in this account.
  const roleRows = await db
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(eq(member.organizationId, accountId));
  const eligible = roleRows
    .filter((r) => HANDLING_ROLES.includes(r.role) && sectorUserIds.includes(r.userId))
    .map((r) => r.userId);
  if (eligible.length === 0) return null;
  if (eligible.length === 1) return eligible[0];

  // Current open-conversation load per eligible agent.
  const load = new Map<string, number>(eligible.map((id) => [id, 0]));
  const openConvs = await db
    .select({ agentId: conversations.assignedAgentId })
    .from(conversations)
    .where(
      and(
        eq(conversations.accountId, accountId),
        eq(conversations.status, 'open'),
        isNotNull(conversations.assignedAgentId),
        inArray(conversations.assignedAgentId, eligible),
      ),
    );
  for (const c of openConvs) {
    if (c.agentId) load.set(c.agentId, (load.get(c.agentId) ?? 0) + 1);
  }

  return eligible.sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0))[0];
}
