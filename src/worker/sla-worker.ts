// ============================================================
// SLA worker — a 1-minute repeatable tick that runs auto-reassign for every
// account with it enabled. Kept tiny: the actual logic lives in
// lib/supervision/sla.ts so it stays testable and web-importable.
// ============================================================

import { Queue, Worker, type Job } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { runSlaReassignAll } from '@/lib/supervision/sla';

const SLA_QUEUE = 'sla-check';

export function startSlaWorker(): Worker {
  const queue = new Queue(SLA_QUEUE, { connection: bullConnection() });

  // Recurring tick. Repeatable jobs are keyed by (name + repeat opts), so
  // calling this on every startup is idempotent (no duplicate schedules).
  void queue
    .add(
      'sla-tick',
      {},
      {
        repeat: { every: 60_000 },
        removeOnComplete: true,
        removeOnFail: 20,
      },
    )
    .catch((err) => console.error('[sla-worker] schedule failed:', err));

  const worker = new Worker(
    SLA_QUEUE,
    async (_job: Job) => {
      await runSlaReassignAll();
    },
    { connection: bullConnection(), concurrency: 1 },
  );

  worker.on('failed', (_job, err) =>
    console.error('[sla-worker] tick failed:', err),
  );
  console.log('[sla-worker] started — SLA reassign tick every 60s');
  return worker;
}
