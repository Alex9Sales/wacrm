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

import { and, eq, inArray } from 'drizzle-orm';

import { db, channels, member, notifications } from '@/db';
import { loadChannel } from '@/lib/channels/channels';
import {
  wahaSessionHealth,
  wahaRestartSession,
} from '@/lib/channels/providers/waha';
import { publishEvent } from '@/lib/events/publish';

// Activity older than this on a WORKING session = suspected zombie. Generous so
// a genuinely quiet channel (which still gets presence/ack events) isn't
// flagged. Tunable via env.
const STALE_MS = Number(process.env.SESSION_STALE_MS) || 30 * 60_000;
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

      const { wahaStatus, activityAgeMs } = await wahaSessionHealth(ch);
      const stale = activityAgeMs !== null && activityAgeMs > STALE_MS;
      const healthy = wahaStatus === 'WORKING' && !stale;

      if (healthy) {
        state.delete(row.id); // recovered → forget so a future issue is fresh
        continue;
      }

      const now = Date.now();
      const st = state.get(row.id) ?? {};
      const why = `waha=${wahaStatus} activity=${
        activityAgeMs === null ? 'none' : Math.round(activityAgeMs / 60_000) + 'min'
      }`;

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
