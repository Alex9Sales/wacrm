// ============================================================
// 🩺 Saúde dos canais Meta (WhatsApp Cloud API) — o que o session-monitor faz
// pro WAHA, feito pra API oficial.
//
// Por quê (02/09): o CRM grava `status='connected'` no Embedded Signup e nunca
// mais confere. A coexistência do 4092 morreu na Meta (Graph: "Object does not
// exist / missing permissions") e o canal ficou VERDE por semanas — com a IA
// muda e ninguém avisado. Aqui: a cada tick, `GET /{phone_number_id}` com o
// token do canal; veredito ok / warn / dead / transient; 2 strikes seguidos
// derrubam pra 'disconnected' + notificação aos admins + aviso no WhatsApp da
// Fluxia; quando volta, restaura sozinho. Erro desconhecido ou rede fora NUNCA
// derruba (transient) — só o que a Meta afirma.
//
// Worker-reachable: sem 'server-only'. Best-effort: um canal que falha não
// derruba a rodada.
// ============================================================

import { and, eq, inArray } from 'drizzle-orm';

import { db, channels, member, notifications } from '@/db';
import { publishEvent } from '@/lib/events/publish';
import { getProvider } from '@/lib/channels/registry';
import { decryptCredentials, loadChannel, updateChannelStatus } from '@/lib/channels/channels';

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const FIELDS = 'status,platform_type,is_on_biz_app,quality_rating,health_status';
/** Strikes seguidos de 'dead' antes de derrubar (anti-flap). */
const STRIKES_TO_DOWN = 2;
const ALERT_COOLDOWN_DOWN_MS = 6 * 60 * 60_000;
const ALERT_COOLDOWN_WARN_MS = 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;

export type MetaHealthVerdict = 'ok' | 'warn' | 'dead' | 'transient';

export interface MetaHealthState {
  last_at?: string | null;
  last_verdict?: MetaHealthVerdict | null;
  /** Motivo do último 'dead' (o que aparece em vermelho na aba Canais). */
  last_error?: string | null;
  /** Motivo do último 'warn' (âmbar). */
  warning?: string | null;
  strikes?: number;
  /** true = foi o monitor que derrubou (então pode restaurar sozinho). */
  marked_down?: boolean;
  alerted_at?: string | null;
  warned_at?: string | null;
}

interface GraphError {
  code?: number;
  message?: string;
  error_subcode?: number;
}

const DEAD_STATUSES = new Set(['DISCONNECTED', 'MIGRATED', 'UNVERIFIED', 'DELETED', 'BANNED']);
const WARN_STATUSES = new Set(['FLAGGED', 'RESTRICTED', 'RATE_LIMITED', 'PENDING', 'UNKNOWN']);
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007]);

/**
 * Veredito PURO a partir da resposta da Graph (testável). Regra de ouro: só
 * afirmações da Meta derrubam; dúvida = transient.
 */
export function classifyMetaHealth(input: {
  httpStatus?: number;
  body?: unknown;
  networkError?: string | null;
}): { verdict: MetaHealthVerdict; reason: string } {
  if (input.networkError) return { verdict: 'transient', reason: `rede: ${input.networkError}` };
  const status = input.httpStatus ?? 0;
  const body = (input.body ?? {}) as Record<string, unknown>;
  const err = body.error as GraphError | undefined;
  if (status === 429 || status >= 500) return { verdict: 'transient', reason: `Graph HTTP ${status}` };
  if (err) {
    const code = Number(err.code ?? 0);
    const msg = String(err.message ?? '').trim();
    if (RATE_LIMIT_CODES.has(code)) return { verdict: 'transient', reason: `rate limit (${code})` };
    if (code === 190) return { verdict: 'dead', reason: 'token de acesso inválido ou expirado (190)' };
    if (code === 100 && /does not exist|Unsupported get request|missing permissions/i.test(msg)) {
      return { verdict: 'dead', reason: 'número não existe mais na Meta ou o app perdeu a permissão (100)' };
    }
    if (code === 10 || code === 200 || code === 803) {
      return { verdict: 'dead', reason: `sem permissão pra ler o número (${code})` };
    }
    return { verdict: 'transient', reason: `erro Graph ${code}: ${msg.slice(0, 80)}` };
  }
  if (status && (status < 200 || status >= 300)) return { verdict: 'transient', reason: `Graph HTTP ${status}` };
  const st = String(body.status ?? '').toUpperCase();
  const hs = body.health_status as { can_send_message?: string } | undefined;
  const canSend = String(hs?.can_send_message ?? '').toUpperCase();
  if (DEAD_STATUSES.has(st)) return { verdict: 'dead', reason: `status ${st} na Meta` };
  if (canSend === 'BLOCKED') return { verdict: 'dead', reason: 'envio BLOQUEADO pela Meta (health_status)' };
  if (WARN_STATUSES.has(st)) return { verdict: 'warn', reason: `status ${st} na Meta` };
  if (canSend === 'LIMITED') return { verdict: 'warn', reason: 'envio LIMITADO pela Meta (health_status)' };
  return { verdict: 'ok', reason: st ? `status ${st}` : 'ok' };
}

async function fetchPhoneHealth(
  phoneNumberId: string,
  accessToken: string,
): Promise<{ httpStatus?: number; body?: unknown; networkError?: string | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}?fields=${FIELDS}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: ctrl.signal,
    });
    let body: unknown = {};
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    return { httpStatus: res.status, body };
  } catch (err) {
    return { networkError: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function tokenFrom(creds: Record<string, unknown>): string | null {
  const t = creds.accessToken ?? creds.access_token ?? creds.token;
  return typeof t === 'string' && t ? t : null;
}

async function saveHealth(
  channelId: string,
  providerMeta: Record<string, unknown>,
  health: MetaHealthState,
): Promise<void> {
  await db
    .update(channels)
    .set({ providerMeta: { ...providerMeta, health }, updatedAt: new Date().toISOString() })
    .where(eq(channels.id, channelId));
}

async function notifyAdmins(accountId: string, title: string, body: string): Promise<void> {
  const members = await db
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(eq(member.organizationId, accountId));
  const ids = members.filter((m) => m.role === 'owner' || m.role === 'admin').map((m) => m.userId);
  if (ids.length === 0) return;
  await db.insert(notifications).values(
    ids.map((userId) => ({
      accountId,
      userId,
      // 'sla_alert' é um type válido do CHECK — mesmo atalho do session-monitor.
      type: 'sla_alert' as const,
      title,
      body,
    })),
  );
  await publishEvent(accountId, { type: 'notification' });
}

/** Aviso no WhatsApp da Fluxia (mesmo destino dos chamados de suporte). Best-effort. */
async function alertPlatform(text: string): Promise<void> {
  try {
    const channelId =
      process.env.PLATFORM_SUPPORT_CHANNEL_ID?.trim() || process.env.PLATFORM_BILLING_CHANNEL_ID?.trim();
    if (!channelId) return;
    const to = process.env.PLATFORM_SUPPORT_ALERT_TO?.replace(/\D/g, '').trim() || '556791806048';
    const ch = await loadChannel(channelId);
    if (!ch) return;
    await getProvider(ch.provider).sendText(ch, to, text);
  } catch (err) {
    console.error('[meta-health] aviso à plataforma falhou:', err);
  }
}

export interface MetaHealthTickResult {
  checked: number;
  down: number;
  restored: number;
  warned: number;
}

/** Uma rodada: confere todo canal Meta que deveria estar vivo. */
export async function runMetaHealthCheck(): Promise<MetaHealthTickResult> {
  const result: MetaHealthTickResult = { checked: 0, down: 0, restored: 0, warned: 0 };
  let rows: {
    id: string;
    accountId: string;
    name: string;
    status: string;
    credentials: string | null;
    providerMeta: unknown;
  }[];
  try {
    rows = await db
      .select({
        id: channels.id,
        accountId: channels.accountId,
        name: channels.name,
        status: channels.status,
        credentials: channels.credentials,
        providerMeta: channels.providerMeta,
      })
      .from(channels)
      .where(and(eq(channels.provider, 'meta'), inArray(channels.status, ['connected', 'error', 'disconnected'])));
  } catch (err) {
    console.error('[meta-health] load channels failed:', err);
    return result;
  }

  const now = Date.now();
  for (const row of rows) {
    try {
      const meta = (row.providerMeta ?? {}) as Record<string, unknown>;
      const health: MetaHealthState = { ...((meta.health as MetaHealthState | undefined) ?? {}) };
      // Desconectado de propósito (não foi o monitor) → não é nosso.
      if (row.status === 'disconnected' && !health.marked_down) continue;
      const pnid = typeof meta.phone_number_id === 'string' ? meta.phone_number_id : null;
      if (!pnid || !row.credentials) continue;
      let token: string | null = null;
      try {
        token = tokenFrom(decryptCredentials(row.credentials));
      } catch {
        token = null;
      }
      if (!token) continue;

      result.checked += 1;
      const raw = await fetchPhoneHealth(pnid, token);
      const { verdict, reason } = classifyMetaHealth(raw);
      health.last_at = new Date(now).toISOString();
      health.last_verdict = verdict;

      if (verdict === 'transient') {
        console.warn(`[meta-health] "${row.name}" (${row.accountId.slice(0, 8)}): transient — ${reason}`);
        await saveHealth(row.id, meta, health);
        continue;
      }

      if (verdict === 'ok') {
        health.strikes = 0;
        health.warning = null;
        if (health.marked_down || row.status !== 'connected') {
          await updateChannelStatus(row.id, 'connected');
          health.marked_down = false;
          health.last_error = null;
          result.restored += 1;
          console.log(`[meta-health] "${row.name}" voltou (${reason}) → connected`);
          await notifyAdmins(
            row.accountId,
            `✅ Canal "${row.name}" voltou`,
            `O WhatsApp oficial "${row.name}" está conectado de novo na Meta. A IA e os envios voltaram ao normal.`,
          );
        }
        await saveHealth(row.id, meta, health);
        continue;
      }

      if (verdict === 'warn') {
        health.strikes = 0;
        health.warning = reason;
        result.warned += 1;
        const last = health.warned_at ? Date.parse(health.warned_at) : 0;
        if (now - last > ALERT_COOLDOWN_WARN_MS) {
          health.warned_at = new Date(now).toISOString();
          await notifyAdmins(
            row.accountId,
            `⚠️ Canal "${row.name}" com restrição na Meta`,
            `A Meta reporta: ${reason}. O número segue conectado, mas pode ter envio limitado. Veja a qualidade do número no Gerenciador do WhatsApp.`,
          );
        }
        console.warn(`[meta-health] "${row.name}": warn — ${reason}`);
        await saveHealth(row.id, meta, health);
        continue;
      }

      // dead
      health.strikes = (health.strikes ?? 0) + 1;
      health.last_error = reason;
      if (health.strikes >= STRIKES_TO_DOWN && row.status !== 'disconnected') {
        await updateChannelStatus(row.id, 'disconnected');
        health.marked_down = true;
        result.down += 1;
        console.error(
          `[meta-health] "${row.name}" (${row.accountId.slice(0, 8)}) MORTO na Meta → disconnected — ${reason}`,
        );
        const last = health.alerted_at ? Date.parse(health.alerted_at) : 0;
        if (now - last > ALERT_COOLDOWN_DOWN_MS) {
          health.alerted_at = new Date(now).toISOString();
          await notifyAdmins(
            row.accountId,
            `🔴 Canal "${row.name}" desconectou da Meta`,
            `A Meta não reconhece mais este número (${reason}). A IA e os envios por ele PARARAM. Reconecte em Configurações → Canais (botão Meta) ou fale com o suporte.`,
          );
          await alertPlatform(
            `🔴 *Canal Meta morto*\nConta: ${row.accountId.slice(0, 8)}…\nCanal: ${row.name}\nMotivo: ${reason}\nO CRM marcou como desconectado e avisou os admins da conta.`,
          );
        }
      } else if (health.strikes < STRIKES_TO_DOWN) {
        console.warn(`[meta-health] "${row.name}": strike ${health.strikes}/${STRIKES_TO_DOWN} — ${reason}`);
      }
      await saveHealth(row.id, meta, health);
    } catch (err) {
      console.error(`[meta-health] canal ${row.id} falhou:`, err);
    }
  }
  if (result.checked > 0) {
    console.log(
      `[meta-health] ${result.checked} canal(is) conferido(s) · ${result.down} derrubado(s) · ${result.restored} restaurado(s) · ${result.warned} com aviso`,
    );
  }
  return result;
}
