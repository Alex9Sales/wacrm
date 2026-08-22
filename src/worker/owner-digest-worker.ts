// ============================================================
// Owner-digest worker — tick de 15 min que roda o sweep do "Sócio IA":
// para cada conta com o resumo LIGADO, envia o briefing diário no WhatsApp do
// dono quando bate a hora configurada (no fuso da conta) e ainda não enviou
// hoje. A lógica (com todas as travas) vive em lib/reports/owner-digest.ts, que
// NÃO importa 'server-only' (senão derruba o worker). Espelha o sla-worker.
// ============================================================

import { Queue, Worker, type Job } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { runOwnerDigestSweep } from '@/lib/reports/owner-digest';

const DIGEST_QUEUE = 'owner-digest';
const TICK_MS = 15 * 60_000; // 15 min — a trava de hora + o anti-dup garantem 1/dia.

export function startOwnerDigestWorker(): Worker {
  const queue = new Queue(DIGEST_QUEUE, { connection: bullConnection() });

  // Tick recorrente (idempotente pela chave repeat).
  void queue
    .add(
      'owner-digest-tick',
      {},
      { repeat: { every: TICK_MS }, removeOnComplete: true, removeOnFail: 20 },
    )
    .catch((err) => console.error('[owner-digest] schedule failed:', err));

  const worker = new Worker(
    DIGEST_QUEUE,
    async (_job: Job) => {
      const { sent } = await runOwnerDigestSweep();
      if (sent > 0) console.log(`[owner-digest] enviou ${sent} resumo(s)`);
    },
    { connection: bullConnection(), concurrency: 1 },
  );

  worker.on('failed', (_job, err) =>
    console.error('[owner-digest] tick failed:', err),
  );
  console.log('[owner-digest] started — resumo diário tick a cada 15min');
  return worker;
}
