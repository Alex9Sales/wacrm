// ============================================================
// SLA auto-reassign (Phase 3) — sector-aware, "só sem 1ª resposta".
//
// Runs from the worker on a 1-minute tick over open, assigned conversations
// that have waited past the account's SLA window. Two paths:
//
//   • Never replied yet (no human-agent message): REASSIGN to another handling
//     member OF THE SAME SECTOR (least-loaded). A null-sector (general-queue)
//     conversation falls back to any handling member.
//
//   • Already engaged (the agent replied at least once) or nobody to hand off
//     to: DON'T reassign — raise an `sla_alert` notification to the account's
//     admins/owner instead.
//
// The SLA clock starts at max(oldest-unanswered-customer-msg, assigned_at), so
// a just-reassigned conversation gives the new agent the full window.
//
// 02/10/2026 — TUDO POR EPISÓDIO DE ESPERA. Medido numa clínica (janela de
// 5 min), 30 dias: 340 mil avisos "Atendimento demorando" (quase todos nunca
// lidos; até 12 mil numa conversa só, um a cada ~6 min) e 8.400
// redistribuições em 65 conversas — 99,7% delas devolvendo a conversa para
// quem a tinha dois passos antes (A→B→A→B… a cada 6 min, por dias, com o
// cliente esperando). Causas: (a) a trava do aviso só olhava UMA janela para
// trás, então o aviso voltava a cada janela; (b) a redistribuição não tinha
// memória — o relógio recomeçava em assigned_at e, uma janela depois, a
// conversa ia de novo para o menos carregado (o anterior).
//
// Agora, por episódio (= desde a 1ª mensagem do cliente ainda sem resposta;
// resposta que chega ao cliente encerra; mensagem nova do cliente depois disso
// abre outro — ver computeWaitState em ./queries):
//   1. no máximo UM aviso "Atendimento demorando" por conversa — e depois do
//      aviso o SLA não mexe mais nela até o episódio acabar;
//   2. no máximo UMA redistribuição automática, nunca para quem já teve a
//      conversa no episódio; se quem recebeu também não responde na janela,
//      vira o aviso (1) para os admins, em vez de passar adiante de novo.
// Estado SEM coluna nova, nas notifications que já existem (ninguém apaga):
//   • aviso dado = sla_alert SLA_ALERT_TITLE desta conversa criado desde o
//     início do episódio;
//   • redistribuição feita = a notificação que o próprio SLA grava para quem
//     recebe (SLA_REASSIGN_TITLE) desde o início do episódio.
// Uma memória no processo do worker evita reconsultar isso a cada minuto; se
// ela some (deploy/restart), o banco responde a mesma coisa.
// ============================================================

import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import {
  db,
  conversations,
  member,
  accountSettings,
  sectorMembers,
  notifications,
  contacts,
} from '@/db';
import type { AccountSettings } from '@/lib/settings/account-settings';
import { publishEvent } from '@/lib/events/publish';
import { walkAccountMessages, type WaitState } from './queries';

/** Roles that actually handle conversations (viewers are read-only). */
const HANDLING_ROLES = new Set(['owner', 'admin', 'agent']);

/** Título do aviso aos admins. É também a CHAVE da trava "um por episódio" —
 *  trocar o texto sem trocar a busca religa a enxurrada. */
export const SLA_ALERT_TITLE = 'Atendimento demorando';

/** Título da notificação que o SLA grava para quem RECEBE a conversa. É a
 *  marca de "já redistribuí nesta espera" (o gatilho do banco grava o genérico
 *  "Nova conversa atribuída" para qualquer troca, então não serve de marca). */
export const SLA_REASSIGN_TITLE = 'Conversa redistribuída para você';

/** Até onde olhar para trás procurando quem estava com a conversa quando a
 *  espera começou (só consultado quando ela trocou de mãos no episódio). */
const HOLDER_LOOKBACK_MS = 7 * 86_400_000;

export type SlaAlertReason = 'engaged' | 'no_candidate' | 'after_reassign';

// O texto antigo ("o atendente já respondeu antes") saía também quando o
// motivo era "ninguém para assumir" — agora cada motivo diz o seu.
const ALERT_BODY: Record<SlaAlertReason, (quem: string) => string> = {
  engaged: (quem) =>
    `A conversa com ${quem} passou do tempo de resposta e o atendente já respondeu antes — dá uma olhada.`,
  after_reassign: (quem) =>
    `A conversa com ${quem} foi redistribuída e continua sem resposta — dá uma olhada.`,
  no_candidate: (quem) =>
    `A conversa com ${quem} passou do tempo de resposta e não há outra pessoa no setor para assumir — dá uma olhada.`,
};

export function slaAlertBody(reason: SlaAlertReason, contactName: string | null): string {
  return ALERT_BODY[reason](contactName || 'um cliente');
}

export function slaReassignBody(contactName: string | null, waitedMin: number): string {
  return `${contactName || 'Um cliente'} espera resposta há ${waitedMin} min — a conversa passou para você.`;
}

// ------------------------------------------------------------
// Acesso a dados — em produção o banco (dbSlaStore); nos testes, memória.
// ------------------------------------------------------------

export interface SlaConversation {
  id: string;
  assignedAgentId: string | null;
  assignedAt: string | null;
  sectorId: string | null;
  contactId: string | null;
}

/** Uma troca de dono registrada em notifications (conversation_assigned). */
export interface SlaAssignment {
  userId: string;
  createdAt: string;
  /** Gravada pelo próprio SLA (SLA_REASSIGN_TITLE). */
  bySla: boolean;
}

interface ConvRef {
  accountId: string;
  conversationId: string;
}

export interface SlaStore {
  waitState(accountId: string): Promise<Pick<WaitState, 'pendingByConv' | 'agentRepliedConvs'>>;
  openAssignedConversations(accountId: string): Promise<SlaConversation[]>;
  members(accountId: string): Promise<{ userId: string; role: string }[]>;
  sectorMemberIds(sectorId: string): Promise<string[]>;
  /** Já existe aviso SLA_ALERT_TITLE desta conversa criado a partir de sinceIso? */
  hasSlaAlertSince(q: ConvRef & { sinceIso: string; userIds: string[] }): Promise<boolean>;
  /** Trocas de dono desta conversa a partir de sinceIso, mais antiga primeiro. */
  assignmentsSince(q: ConvRef & { sinceIso: string; userIds: string[] }): Promise<SlaAssignment[]>;
  /** Quem recebeu a conversa por último antes de beforeIso (sem passar de notBeforeIso). */
  holderBefore(
    q: ConvRef & { beforeIso: string; notBeforeIso: string; userIds: string[] },
  ): Promise<string | null>;
  /** Troca o dono SE ainda for fromAgentId (outra pessoa pode ter mexido) e
   *  grava a notificação-marca para quem recebe. true = trocou. */
  reassign(
    r: ConvRef & {
      contactId: string | null;
      fromAgentId: string;
      toAgentId: string;
      waitedMin: number;
    },
  ): Promise<boolean>;
  insertSlaAlert(
    a: ConvRef & { contactId: string | null; userIds: string[]; reason: SlaAlertReason },
  ): Promise<void>;
}

async function contactNameOf(contactId: string | null): Promise<string | null> {
  if (!contactId) return null;
  const [c] = await db
    .select({ name: contacts.name })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  return c?.name || null;
}

// As buscas em notifications filtram por user_id + created_at (o único índice
// da tabela, idx_notifications_user_created); conversation_id não tem índice.
// Medido em produção em 02/10 (360 mil linhas): ~40 ms por busca no pior caso
// (seq scan) — por isso a memória do worker mais abaixo: cada conversa custa
// uma ou duas buscas por EPISÓDIO, não uma por minuto.
export const dbSlaStore: SlaStore = {
  async waitState(accountId) {
    return walkAccountMessages(accountId);
  },

  async openAssignedConversations(accountId) {
    return db
      .select({
        id: conversations.id,
        assignedAgentId: conversations.assignedAgentId,
        assignedAt: conversations.assignedAt,
        sectorId: conversations.sectorId,
        contactId: conversations.contactId,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.accountId, accountId),
          eq(conversations.status, 'open'),
          isNotNull(conversations.assignedAgentId),
        ),
      );
  },

  async members(accountId) {
    return db
      .select({ userId: member.userId, role: member.role })
      .from(member)
      .where(eq(member.organizationId, accountId));
  },

  async sectorMemberIds(sectorId) {
    const rows = await db
      .select({ userId: sectorMembers.userId })
      .from(sectorMembers)
      .where(eq(sectorMembers.sectorId, sectorId));
    return rows.map((r) => r.userId);
  },

  async hasSlaAlertSince({ accountId, conversationId, sinceIso, userIds }) {
    if (userIds.length === 0) return false;
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          inArray(notifications.userId, userIds),
          gte(notifications.createdAt, sinceIso),
          eq(notifications.accountId, accountId),
          eq(notifications.conversationId, conversationId),
          eq(notifications.type, 'sla_alert'),
          eq(notifications.title, SLA_ALERT_TITLE),
        ),
      )
      .limit(1);
    return rows.length > 0;
  },

  async assignmentsSince({ accountId, conversationId, sinceIso, userIds }) {
    if (userIds.length === 0) return [];
    const rows = await db
      .select({
        userId: notifications.userId,
        title: notifications.title,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(
        and(
          inArray(notifications.userId, userIds),
          gte(notifications.createdAt, sinceIso),
          eq(notifications.accountId, accountId),
          eq(notifications.conversationId, conversationId),
          eq(notifications.type, 'conversation_assigned'),
        ),
      )
      .orderBy(asc(notifications.createdAt));
    return rows.map((r) => ({
      userId: r.userId,
      createdAt: r.createdAt,
      bySla: r.title === SLA_REASSIGN_TITLE,
    }));
  },

  async holderBefore({ accountId, conversationId, beforeIso, notBeforeIso, userIds }) {
    if (userIds.length === 0) return null;
    // created_at é NOT NULL em notifications — o DESC não traz NULL na frente.
    const [row] = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(
        and(
          inArray(notifications.userId, userIds),
          gte(notifications.createdAt, notBeforeIso),
          lt(notifications.createdAt, beforeIso),
          eq(notifications.accountId, accountId),
          eq(notifications.conversationId, conversationId),
          eq(notifications.type, 'conversation_assigned'),
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    return row?.userId ?? null;
  },

  async reassign({ accountId, conversationId, contactId, fromAgentId, toAgentId, waitedMin }) {
    const contactName = await contactNameOf(contactId);
    const moved = await db.transaction(async (tx) => {
      // Cala o gatilho notify_conversation_assigned (o genérico "Nova conversa
      // atribuída"): a notificação do SLA, com o motivo, vai logo abaixo — e é
      // ela a marca de "já redistribuí nesta espera". Mesma transação: ou as
      // duas coisas ficam, ou nenhuma (sem marca, o vaivém voltaria).
      await tx.execute(sql`SET LOCAL app.suppress_assign_notify = 'on'`);
      const rows = await tx
        .update(conversations)
        .set({ assignedAgentId: toAgentId, assignedAt: new Date().toISOString() })
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.accountId, accountId),
            eq(conversations.status, 'open'),
            // Só se ainda está com quem lemos: não atropela quem transferiu
            // ou fechou a conversa à mão no meio do tick.
            eq(conversations.assignedAgentId, fromAgentId),
          ),
        )
        .returning({ id: conversations.id });
      if (rows.length === 0) return false;
      await tx.insert(notifications).values({
        accountId,
        userId: toAgentId,
        type: 'conversation_assigned' as const,
        conversationId,
        contactId: contactId ?? null,
        title: SLA_REASSIGN_TITLE,
        body: slaReassignBody(contactName, waitedMin),
      });
      return true;
    });
    if (moved) await publishEvent(accountId, { type: 'notification' });
    return moved;
  },

  async insertSlaAlert({ accountId, conversationId, contactId, userIds, reason }) {
    if (userIds.length === 0) return;
    const body = slaAlertBody(reason, await contactNameOf(contactId));
    await db.insert(notifications).values(
      userIds.map((userId) => ({
        accountId,
        userId,
        type: 'sla_alert' as const,
        conversationId,
        contactId: contactId ?? null,
        title: SLA_ALERT_TITLE,
        body,
      })),
    );
    await publishEvent(accountId, { type: 'notification' });
  },
};

// ------------------------------------------------------------
// Memória do worker: o que JÁ se sabe de cada episódio, para não perguntar ao
// banco a cada minuto. Só guarda fatos positivos (que não "desacontecem" no
// mesmo episódio); reconstruída a cada tick com as conversas que ainda
// esperam, então não cresce.
// ------------------------------------------------------------

interface EpisodeMemo {
  episodeStart: number;
  /** Já há aviso SLA_ALERT_TITLE neste episódio → o SLA terminou com ela. */
  alerted: boolean;
  /** O SLA já redistribuiu neste episódio. */
  slaReassigned: boolean;
}

/** accountId → (conversationId → episódio). */
export type SlaMemory = Map<string, Map<string, EpisodeMemo>>;

const workerMemory: SlaMemory = new Map();

export interface SlaDeps {
  store?: SlaStore;
  memory?: SlaMemory;
  now?: number;
}

export async function runSlaReassignForAccount(
  accountId: string,
  minutes: number,
  deps: SlaDeps = {},
): Promise<number> {
  const store = deps.store ?? dbSlaStore;
  const memory = deps.memory ?? workerMemory;
  const now = deps.now ?? Date.now();
  const windowMs = Math.max(1, minutes) * 60_000;

  const { pendingByConv, agentRepliedConvs } = await store.waitState(accountId);
  const convs = await store.openAssignedConversations(accountId);

  // Handling-role members of the account, and the current open load per agent.
  const members = await store.members(accountId);
  const memberIds = members.map((m) => m.userId);
  const handling = new Set(
    members.filter((m) => HANDLING_ROLES.has(m.role)).map((m) => m.userId),
  );
  const adminUserIds = members
    .filter((m) => m.role === 'owner' || m.role === 'admin')
    .map((m) => m.userId);

  const loadByAgent = new Map<string, number>();
  for (const c of convs) {
    if (c.assignedAgentId) {
      loadByAgent.set(c.assignedAgentId, (loadByAgent.get(c.assignedAgentId) ?? 0) + 1);
    }
  }

  // Sector → handling-member ids (built lazily, cached per run).
  const sectorPoolCache = new Map<string, string[]>();
  const sectorPool = async (sectorId: string): Promise<string[]> => {
    const cached = sectorPoolCache.get(sectorId);
    if (cached) return cached;
    const pool = (await store.sectorMemberIds(sectorId)).filter((id) => handling.has(id));
    sectorPoolCache.set(sectorId, pool);
    return pool;
  };
  // Global handling pool for null-sector (general queue) conversations.
  const globalPool = [...handling];

  const known = memory.get(accountId);
  const memos = new Map<string, EpisodeMemo>();

  let reassigned = 0;
  for (const c of convs) {
    const fromAgentId = c.assignedAgentId;
    if (!fromAgentId) continue;
    const episodeStart = pendingByConv.get(c.id);
    if (episodeStart == null) continue; // not awaiting a reply

    const prev = known?.get(c.id);
    const memo: EpisodeMemo =
      prev && prev.episodeStart === episodeStart
        ? prev
        : { episodeStart, alerted: false, slaReassigned: false };
    memos.set(c.id, memo);

    const assignedAtMs = c.assignedAt ? Date.parse(c.assignedAt) || 0 : 0;
    const clockStart = Math.max(episodeStart, assignedAtMs);
    if (now - clockStart < windowMs) continue; // still within the window

    const ref = { accountId, conversationId: c.id };
    const sinceIso = new Date(episodeStart).toISOString();
    const alert = async (reason: SlaAlertReason) => {
      await store.insertSlaAlert({ ...ref, contactId: c.contactId, userIds: adminUserIds, reason });
      memo.alerted = true;
    };

    try {
      // 1) Já avisou os admins nesta espera → nada mais (nem aviso, nem troca).
      //    Sem admin para avisar não há o que esperar: conta como avisado.
      if (!memo.alerted) {
        memo.alerted =
          adminUserIds.length === 0 ||
          (await store.hasSlaAlertSince({ ...ref, sinceIso, userIds: adminUserIds }));
      }
      if (memo.alerted) continue;

      // 2) Already engaged (a human agent replied at least once) → alert only.
      if (agentRepliedConvs.has(c.id)) {
        await alert('engaged');
        continue;
      }

      // 3) Já redistribuí nesta espera? Só é possível se a atribuição atual é
      //    de pelo menos uma janela depois do início (o SLA nunca age antes),
      //    então a conversa nova, atribuída na chegada, nem consulta o banco.
      let history: SlaAssignment[] | null = null;
      if (!memo.slaReassigned && assignedAtMs >= episodeStart + windowMs) {
        history = await store.assignmentsSince({ ...ref, sinceIso, userIds: memberIds });
        memo.slaReassigned = history.some((h) => h.bySla);
      }
      if (memo.slaReassigned) {
        // Quem recebeu também não respondeu: sobe para os admins, uma vez.
        await alert('after_reassign');
        continue;
      }

      // 4) Redistribui (uma vez), nunca para quem já teve a conversa nesta
      //    espera: quem está com ela, quem a recebeu desde o início da espera
      //    e — se ela trocou de mãos — quem estava com ela quando começou.
      const episodeHistory =
        history ?? (await store.assignmentsSince({ ...ref, sinceIso, userIds: memberIds }));
      const holders = new Set<string>([fromAgentId, ...episodeHistory.map((h) => h.userId)]);
      if (episodeHistory.length > 0) {
        const atStart = await store.holderBefore({
          ...ref,
          beforeIso: sinceIso,
          notBeforeIso: new Date(episodeStart - HOLDER_LOOKBACK_MS).toISOString(),
          userIds: memberIds,
        });
        if (atStart) holders.add(atStart);
      }

      // Never replied → reassign within the same sector (or global if none).
      const pool = c.sectorId ? await sectorPool(c.sectorId) : globalPool;
      const candidates = pool
        .filter((id) => !holders.has(id))
        .sort((a, b) => (loadByAgent.get(a) ?? 0) - (loadByAgent.get(b) ?? 0));
      if (candidates.length === 0) {
        // No one else in the sector to hand off to — alert instead of dropping it.
        // Se havia gente mas todos já tiveram a conversa nesta espera, ela já
        // rodou de mão em mão: o aviso diz isso.
        const passouPorOutros = pool.some((id) => id !== fromAgentId && holders.has(id));
        await alert(passouPorOutros ? 'after_reassign' : 'no_candidate');
        continue;
      }
      const target = candidates[0];

      const moved = await store.reassign({
        ...ref,
        contactId: c.contactId,
        fromAgentId,
        toAgentId: target,
        waitedMin: Math.max(0, Math.floor((now - episodeStart) / 60_000)),
      });
      if (!moved) continue; // alguém mexeu na conversa no meio — o próximo tick relê
      memo.slaReassigned = true;
      loadByAgent.set(fromAgentId, (loadByAgent.get(fromAgentId) ?? 1) - 1);
      loadByAgent.set(target, (loadByAgent.get(target) ?? 0) + 1);
      reassigned += 1;
      console.log(`[sla] reassigned conversation ${c.id} (${accountId}) ${fromAgentId} → ${target}`);
    } catch (err) {
      // Uma conversa com erro não derruba as outras; o próximo tick tenta de
      // novo (a memória só marca o que deu certo).
      console.error(`[sla] conversation ${c.id} (${accountId}) failed:`, err);
    }
  }

  memory.set(accountId, memos);
  return reassigned;
}

/** Scan every account that has auto-reassign enabled and run its SLA. */
export async function runSlaReassignAll(): Promise<void> {
  const rows = await db
    .select({
      accountId: accountSettings.accountId,
      settings: accountSettings.settings,
    })
    .from(accountSettings);

  for (const r of rows) {
    const s = (r.settings ?? {}) as Partial<AccountSettings>;
    if (!s.autoReassignEnabled) {
      workerMemory.delete(r.accountId);
      continue;
    }
    const minutes =
      typeof s.autoReassignMinutes === 'number' && s.autoReassignMinutes > 0
        ? s.autoReassignMinutes
        : 5;
    try {
      await runSlaReassignForAccount(r.accountId, minutes);
    } catch (err) {
      console.error(`[sla] account ${r.accountId} failed:`, err);
    }
  }
}
