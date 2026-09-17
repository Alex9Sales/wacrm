// ============================================================
// 📅 Sincronização automática da Agenda do Google — tick a cada 5 min.
// Até 17/09 a importação só rodava quando alguém clicava "Sincronizar" na tela
// da Agenda (ou no instante da conexão). Isso bastava enquanto quem marcava
// reunião era gente; com a IA oferecendo horário sozinha (Zélia, Limpeza com
// Zelo), a agenda precisa estar fresca sem ninguém clicar — senão ela oferece
// em cima de um compromisso que o dono marcou pelo celular.
// ============================================================

import { Queue, Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { syncAllGoogleConnections } from '@/lib/google/sync';

const QUEUE = 'google-sync';
const EVERY_MS = Number(process.env.GOOGLE_SYNC_EVERY_MS) || 5 * 60_000;

export function startGoogleSyncWorker(): Worker {
  const queue = new Queue(QUEUE, { connection: bullConnection() });
  void (async () => {
    try {
      for (const r of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(r.key);
      await queue.add('google-sync-tick', {}, { repeat: { every: EVERY_MS }, removeOnComplete: true, removeOnFail: 20 });
    } catch (err) {
      console.error('[google-sync] schedule failed:', err);
    }
  })();
  const worker = new Worker(
    QUEUE,
    async () => {
      const r = await syncAllGoogleConnections();
      if (r.failed) console.warn(`[google-sync] tick: ${r.ok} ok, ${r.failed} com erro`);
      return r;
    },
    { connection: bullConnection(), concurrency: 1 },
  );
  worker.on('failed', (_job, err) => console.error('[google-sync] tick failed:', err));
  console.log(`[google-sync] started — tick every ${Math.round(EVERY_MS / 60000)}min`);
  return worker;
}
