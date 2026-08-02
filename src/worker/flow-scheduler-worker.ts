// ============================================================
// Flow scheduler worker — a 1-minute repeatable tick that (a) resumes drip
// flow runs whose `delay` node has elapsed and (b) fires the no-reply timeout
// on runs parked at a suspending node past their deadline. Kept tiny: the
// actual logic lives in lib/flows/engine.ts (resumeSleepingRuns /
// resumeTimedOutRuns) so it stays testable and web-importable. Mirrors
// sla-worker's shape.
// ============================================================

import { Queue, Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { resumeSleepingRuns, resumeTimedOutRuns } from '@/lib/flows/engine';

const FLOW_SCHEDULER_QUEUE = 'flow-scheduler';

export function startFlowSchedulerWorker(): Worker {
  const queue = new Queue(FLOW_SCHEDULER_QUEUE, { connection: bullConnection() });

  // Recurring tick. Repeatable jobs are keyed by (name + repeat opts), so
  // calling this on every startup is idempotent (no duplicate schedules).
  void queue
    .add(
      'flow-scheduler-tick',
      {},
      {
        repeat: { every: 60_000 },
        removeOnComplete: true,
        removeOnFail: 20,
      },
    )
    .catch((err) =>
      console.error('[flow-scheduler] schedule failed:', err),
    );

  const worker = new Worker(
    FLOW_SCHEDULER_QUEUE,
    async () => {
      const { resumed } = await resumeSleepingRuns();
      if (resumed > 0) {
        console.log(`[flow-scheduler] resumed ${resumed} drip run(s)`);
      }
      const { fired } = await resumeTimedOutRuns();
      if (fired > 0) {
        console.log(`[flow-scheduler] fired ${fired} no-reply timeout(s)`);
      }
    },
    { connection: bullConnection(), concurrency: 1 },
  );

  worker.on('failed', (_job, err) =>
    console.error('[flow-scheduler] tick failed:', err),
  );
  console.log('[flow-scheduler] started — drip resume tick every 60s');
  return worker;
}
