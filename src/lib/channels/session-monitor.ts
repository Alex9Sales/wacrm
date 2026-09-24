// ============================================================
// WAHA session health monitor.
//
// The problem it solves (seen live 27/07): a WAHA/NOWEB session can sit at
// status WORKING while its message stream is DEAD — the device link went stale,
// WhatsApp stopped routing inbound messages, but the CRM channel still shows
// "Conectado" because both WAHA and the CRM believe it's fine. The number
// silently stops receiving; nobody notices until a customer complains.
//
// This tick (run by the worker every few minutes) diffs each connected WAHA
// channel's `timestamps.activity`. When a session looks unhealthy it:
//   1. tries a soft RESTART once (reuses creds, no QR — recovers many stalls);
//   2. if it's still unhealthy after the restart, ALERTS the account's
//      owner/admins (notification) to reconnect — a dead device link needs a
//      human to re-pair (scan a fresh QR).
//
// State (last restart / last alert per channel) is kept in-memory: on a worker
// restart it re-evaluates from scratch, which at worst re-alerts once — fine.
// ============================================================

import { and, desc, eq, inArray } from 'drizzle-orm';

import { db, channels, conversations, member, messages, notifications } from '@/db';
import { loadChannel } from '@/lib/channels/channels';
import {
  sessionVerdict,
  verdictReason,
  ZOMBIE_SILENCE_MS,
} from '@/lib/channels/session-health-rules';
import {
  wahaSessionHealth,
  wahaRestartSession,
  wahaEnsureWebhookEvents,
  WAHA_WEBHOOK_EVENTS,
} from '@/lib/channels/providers/waha';

// Reconciliação de webhook: 1 tentativa por canal por processo (falha
// persistente não vira martelo na API do WAHA).
const webhookReconciled = new Set<string>();
import { publishEvent } from '@/lib/events/publish';

// Don't restart the same channel more than once per window (avoid churn / a
// restart loop on a session that actually needs a human re-pair).
const RESTART_COOLDOWN_MS = 30 * 60_000;
// Don't re-alert the same channel more than once per window.
const ALERT_COOLDOWN_MS = 60 * 60_000;

interface ChannelState {
  restartedAt?: number;
  alertedAt?: number;
}
const state = new Map<string, ChannelState>();

/**
 * Há quanto tempo este canal trocou a última mensagem. É o que separa um
 * canal que parou de entregar (precisa de reinício) de um canal que está
 * simplesmente quieto (não se mexe). null = nunca trocou nada.
 */
async function channelTrafficAgeMs(channelId: string): Promise<number | null> {
  try {
    const row = await db
      .select({ at: messages.createdAt })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(conversations.channelId, channelId))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    const at = row[0]?.at;
    if (!at) return null;
    return Date.now() - new Date(at).getTime();
  } catch (err) {
    console.error('[session-monitor] leitura de tráfego falhou:', err);
    return null;
  }
}

export async function runSessionHealthCheck(): Promise<void> {
  let rows: { id: string; accountId: string; name: string }[];
  try {
    rows = await db
      .select({
        id: channels.id,
        accountId: channels.accountId,
        name: channels.name,
      })
      .from(channels)
      // Watch channels that SHOULD be live: 'connected' (catch the zombie) AND
      // 'error' (a session that already dropped). Before, 'error' channels were
      // skipped → a dead session (ex.: Comercial1) NUNCA gerava alerta, o dono
      // só descobria quando a vendedora reclamava. 'disconnected'/'pending'
      // (desligado/nunca pareado de propósito) ficam de fora pra não spammar.
      .where(
        and(
          eq(channels.provider, 'waha'),
          inArray(channels.status, ['connected', 'error']),
        ),
      );
  } catch (err) {
    console.error('[session-monitor] load channels failed:', err);
    return;
  }

  for (const row of rows) {
    try {
      const ch = await loadChannel(row.id);
      if (!ch) continue;

      const { wahaStatus, activityAgeMs, webhookEvents } =
        await wahaSessionHealth(ch);
      // Só busca o tráfego do canal quando a sessão está WORKING e calada —
      // é o único caso em que a resposta muda a decisão.
      const trafficAgeMs =
        wahaStatus === 'WORKING' && activityAgeMs !== null && activityAgeMs > ZOMBIE_SILENCE_MS
          ? await channelTrafficAgeMs(row.id)
          : null;
      const signals = { wahaStatus, activityAgeMs, trafficAgeMs };
      const verdict = sessionVerdict(signals);

      if (verdict === 'healthy') {
        state.delete(row.id); // recovered → forget so a future issue is fresh
        // Sessão antiga com lista de eventos defasada (criada antes de um
        // evento novo existir) → completa os que faltam (ex.: message.edited).
        if (
          !webhookReconciled.has(row.id) &&
          webhookEvents !== null &&
          WAHA_WEBHOOK_EVENTS.some((e) => !webhookEvents.includes(e))
        ) {
          webhookReconciled.add(row.id);
          await wahaEnsureWebhookEvents(ch).catch(() => false);
        }
        continue;
      }

      const now = Date.now();
      const st = state.get(row.id) ?? {};
      const why = verdictReason(signals, verdict);

      // 1) Soft restart once per cooldown — recovers many stalls, no QR.
      if (!st.restartedAt || now - st.restartedAt > RESTART_COOLDOWN_MS) {
        const ok = await wahaRestartSession(ch).catch(() => false);
        state.set(row.id, { ...st, restartedAt: now });
        console.warn(
          `[session-monitor] "${row.name}" unhealthy (${why}) → restart ${
            ok ? 'ok' : 'FAILED'
          }`,
        );
        continue; // give it a tick to come back before alerting
      }

      // 2) Restarted recently and STILL unhealthy → needs a human. Alert once.
      if (!st.alertedAt || now - st.alertedAt > ALERT_COOLDOWN_MS) {
        await alertOwners(row.accountId, row.name, why);
        state.set(row.id, { ...st, alertedAt: now });
        console.warn(
          `[session-monitor] "${row.name}" still unhealthy after restart (${why}) → alerted owners`,
        );
      }
    } catch (err) {
      console.error(`[session-monitor] channel ${row.id} check failed:`, err);
    }
  }
}

async function alertOwners(
  accountId: string,
  channelName: string,
  why: string,
): Promise<void> {
  const members = await db
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(eq(member.organizationId, accountId));
  const adminUserIds = members
    .filter((m) => m.role === 'owner' || m.role === 'admin')
    .map((m) => m.userId);
  if (adminUserIds.length === 0) return;

  await db.insert(notifications).values(
    adminUserIds.map((userId) => ({
      accountId,
      userId,
      // Reusing 'sla_alert' (a valid notifications.type) to avoid a migration;
      // the title carries the real meaning. A dedicated type can come later.
      type: 'sla_alert' as const,
      title: `⚠️ Canal "${channelName}" parou de receber`,
      body: `O WhatsApp "${channelName}" está mostrando conectado mas parou de receber mensagens (${why}). Reconecte pelo Reparear em Configurações → Canais (pode pedir para escanear o QR de novo).`,
    })),
  );
  await publishEvent(accountId, { type: 'notification' });
}
