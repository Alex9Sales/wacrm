// ============================================================
// Session-monitor worker — a repeatable tick that checks every connected WAHA
// channel for a "zombie" session (shows connected but stopped receiving) and
// restarts / alerts. Logic lives in lib/channels/session-monitor.ts so it stays
// testable and web-importable. Mirrors the sla-worker shape.
// ============================================================

import { Queue, Worker, type Job } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { runSessionHealthCheck } from '@/lib/channels/session-monitor';

const QUEUE = 'session-monitor';
const EVERY_MS = Number(process.env.SESSION_MONITOR_EVERY_MS) || 5 * 60_000;

export function startSessionMonitor(): Worker {
  const queue = new Queue(QUEUE, { connection: bullConnection() });

  // Repeatable jobs are keyed by (name + repeat opts), so scheduling on every
  // startup is idempotent (no duplicate schedules).
  void queue
    .add(
      'session-tick',
      {},
      { repeat: { every: EVERY_MS }, removeOnComplete: true, removeOnFail: 20 },
    )
    .catch((err) =>
      console.error('[session-monitor] schedule failed:', err),
    );

  const worker = new Worker(
    QUEUE,
    async (_job: Job) => {
      await runSessionHealthCheck();
    },
    { connection: bullConnection(), concurrency: 1 },
  );

  worker.on('failed', (_job, err) =>
    console.error('[session-monitor] tick failed:', err),
  );
  console.log(
    `[session-monitor] started — WAHA session health check every ${Math.round(
      EVERY_MS / 1000,
    )}s`,
  );
  return worker;
}
