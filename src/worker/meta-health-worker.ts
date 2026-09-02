// ============================================================
// 🩺 Monitor de saúde dos canais Meta (WhatsApp API oficial) — tick a cada
// 30 min. Espelha o session-monitor do WAHA: o CRM gravava 'connected' no
// Embedded Signup e nunca mais conferia (02/09: coexistência do 4092 morreu
// na Meta e ficou verde na tela por semanas). Lógica em lib/channels/meta-health.
// ============================================================

import { Queue, Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { runMetaHealthCheck } from '@/lib/channels/meta-health';

const QUEUE = 'meta-health';
const EVERY_MS = Number(process.env.META_HEALTH_EVERY_MS) || 30 * 60_000;

export function startMetaHealthWorker(): Worker {
  const queue = new Queue(QUEUE, { connection: bullConnection() });
  void (async () => {
    try {
      for (const r of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(r.key);
      await queue.add('meta-health-tick', {}, { repeat: { every: EVERY_MS }, removeOnComplete: true, removeOnFail: 20 });
    } catch (err) {
      console.error('[meta-health] schedule failed:', err);
    }
  })();
  const worker = new Worker(QUEUE, async () => runMetaHealthCheck(), {
    connection: bullConnection(),
    concurrency: 1,
  });
  worker.on('failed', (_job, err) => console.error('[meta-health] tick failed:', err));
  console.log(`[meta-health] started — tick every ${Math.round(EVERY_MS / 60000)}min`);
  return worker;
}
