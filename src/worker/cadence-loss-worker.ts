// ============================================================
// ⏳ Cadência — perdas que venceram. Tick a cada 5 min.
// Cadência com "espera antes de perder" (cadences.lose_after_hours) deixa a
// inscrição ATIVA com `lose_at` depois do último toque; se o lead não
// respondeu até lá, marca o card perdido com o motivo da cadência. Ver
// runCadenceLossSweep em lib/cadences/cadence.ts.
// ============================================================

import { Queue, Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { runCadenceLossSweep } from '@/lib/cadences/cadence';

const QUEUE = 'cadence-loss';
const EVERY_MS = Number(process.env.CADENCE_LOSS_EVERY_MS) || 5 * 60_000;

export function startCadenceLossWorker(): Worker {
  const queue = new Queue(QUEUE, { connection: bullConnection() });
  void (async () => {
    try {
      for (const r of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(r.key);
      await queue.add('cadence-loss-tick', {}, { repeat: { every: EVERY_MS }, removeOnComplete: true, removeOnFail: 20 });
    } catch (err) {
      console.error('[cadence-loss] schedule failed:', err);
    }
  })();
  const worker = new Worker(
    QUEUE,
    async () => {
      const r = await runCadenceLossSweep();
      if (r.lost) console.log(`[cadence-loss] ${r.lost} card(s) perdido(s) por falta de resposta`);
      return r;
    },
    { connection: bullConnection(), concurrency: 1 },
  );
  worker.on('failed', (_job, err) => console.error('[cadence-loss] tick failed:', err));
  console.log(`[cadence-loss] started — tick every ${Math.round(EVERY_MS / 60_000)} min`);
  return worker;
}
