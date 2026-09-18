// ============================================================
// 💧 Entrada gotejada de leads — tick a cada 2 min. Processa as linhas
// vencidas de `lead_drip_queue` (ingestLead na hora certa). Ver
// lib/leads/drip.ts.
// ============================================================

import { Queue, Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { runLeadDripTick } from '@/lib/leads/drip';

const QUEUE = 'lead-drip';
const EVERY_MS = Number(process.env.LEAD_DRIP_EVERY_MS) || 2 * 60_000;

export function startLeadDripWorker(): Worker {
  const queue = new Queue(QUEUE, { connection: bullConnection() });
  void (async () => {
    try {
      for (const r of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(r.key);
      await queue.add('lead-drip-tick', {}, { repeat: { every: EVERY_MS }, removeOnComplete: true, removeOnFail: 20 });
    } catch (err) {
      console.error('[lead-drip] schedule failed:', err);
    }
  })();
  const worker = new Worker(
    QUEUE,
    async () => runLeadDripTick(),
    { connection: bullConnection(), concurrency: 1 },
  );
  worker.on('failed', (_job, err) => console.error('[lead-drip] tick failed:', err));
  console.log(`[lead-drip] started — tick every ${Math.round(EVERY_MS / 60_000)} min`);
  return worker;
}
