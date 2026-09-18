// ============================================================
// 🔁 Espelho com CRM externo (RD Station CRM) — tick a cada 20 s.
// Lê a fila `crm_sync_outbox` (o gatilho em `deals` enfileira toda mudança de
// card em conta com integração ligada) e leva a mudança pro RD. Ver
// lib/integrations/rdcrm/sync.ts.
// ============================================================

import { Queue, Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { processCrmSyncOutbox } from '@/lib/integrations/rdcrm/sync';

const QUEUE = 'crm-sync';
const EVERY_MS = Number(process.env.CRM_SYNC_EVERY_MS) || 20_000;

export function startCrmSyncWorker(): Worker {
  const queue = new Queue(QUEUE, { connection: bullConnection() });
  void (async () => {
    try {
      for (const r of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(r.key);
      await queue.add('crm-sync-tick', {}, { repeat: { every: EVERY_MS }, removeOnComplete: true, removeOnFail: 20 });
    } catch (err) {
      console.error('[crm-sync] schedule failed:', err);
    }
  })();
  const worker = new Worker(
    QUEUE,
    async () => {
      const r = await processCrmSyncOutbox();
      if (r.failed) console.warn(`[crm-sync] tick: ${r.ok} ok, ${r.failed} com erro, ${r.waiting} esperando`);
      return r;
    },
    { connection: bullConnection(), concurrency: 1 },
  );
  worker.on('failed', (_job, err) => console.error('[crm-sync] tick failed:', err));
  console.log(`[crm-sync] started — tick every ${Math.round(EVERY_MS / 1000)}s`);
  return worker;
}
