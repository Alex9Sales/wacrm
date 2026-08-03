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

/**
 * Tick interval. Short (10s) because the same tick fires the `ai` node's
 * message-buffer debounce — a chat reply that waits a full minute feels
 * broken. Drip delays (hours/days) and no-reply timeouts don't need the
 * granularity but the extra indexed queries are cheap.
 */
const TICK_MS = 10_000;

export function startFlowSchedulerWorker(): Worker {
  const queue = new Queue(FLOW_SCHEDULER_QUEUE, { connection: bullConnection() });

  // Recurring tick. Clear any prior repeatable first so changing TICK_MS
  // doesn't leave the old schedule (a different `every` is a NEW repeat
  // key — both would otherwise fire).
  void (async () => {
    try {
      for (const r of await queue.getRepeatableJobs()) {
        await queue.removeRepeatableByKey(r.key);
      }
      await queue.add(
        'flow-scheduler-tick',
        {},
        {
          repeat: { every: TICK_MS },
          removeOnComplete: true,
          removeOnFail: 20,
        },
      );
    } catch (err) {
      console.error('[flow-scheduler] schedule failed:', err);
    }
  })();

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
  console.log(`[flow-scheduler] started — tick every ${TICK_MS / 1000}s`);
  return worker;
}
