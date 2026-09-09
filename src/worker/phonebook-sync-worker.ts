// ============================================================
// 📒 Agenda do celular — tick a cada 6 h: reconfere a agenda dos números WAHA
// que já importaram uma vez (channels.phonebook_synced_at) e aplica a regra de
// nome no modo seguro ('fill': preenche vazio, troca nome de perfil, acompanha
// a agenda; nunca mexe em nome digitado no CRM; não cria contato).
// Lógica em lib/contacts/phonebook.ts. Espelha o meta-health-worker.
// ============================================================

import { Queue, Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { syncAllPhonebooks } from '@/lib/contacts/phonebook';

const QUEUE = 'phonebook-sync';
const EVERY_MS = Number(process.env.PHONEBOOK_SYNC_EVERY_MS) || 6 * 60 * 60_000;

export function startPhonebookSyncWorker(): Worker {
  const queue = new Queue(QUEUE, { connection: bullConnection() });
  void (async () => {
    try {
      for (const r of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(r.key);
      await queue.add('phonebook-tick', {}, { repeat: { every: EVERY_MS }, removeOnComplete: true, removeOnFail: 20 });
    } catch (err) {
      console.error('[phonebook] schedule failed:', err);
    }
  })();
  const worker = new Worker(
    QUEUE,
    async () => {
      const r = await syncAllPhonebooks();
      if (r.channels > 0) console.log(`[phonebook] tick: ${r.channels} canal(is), ${r.failed} falha(s)`);
    },
    { connection: bullConnection(), concurrency: 1 },
  );
  worker.on('failed', (_job, err) => console.error('[phonebook] tick failed:', err));
  console.log(`[phonebook] started — tick every ${Math.round(EVERY_MS / 3600000)}h`);
  return worker;
}
