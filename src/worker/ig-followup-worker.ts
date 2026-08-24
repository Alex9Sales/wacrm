// ============================================================
// IG follow-up worker — tick de 10 min que roda o sweep da cutucada pós-DM
// da automação de comentários (⏰, social selling). Toda a lógica (com as
// travas: só quem respondeu/janela 24h/horário da conta/claim atômico) vive
// em lib/channels/ig-followup.ts, que NÃO importa 'server-only'.
// Espelha o owner-digest-worker.
// ============================================================

import { Queue, Worker, type Job } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { runIgFollowUpSweep } from '@/lib/channels/ig-followup';

const QUEUE = 'ig-comment-followup';
const TICK_MS = 10 * 60_000; // 10 min

export function startIgFollowUpWorker(): Worker {
  const queue = new Queue(QUEUE, { connection: bullConnection() });

  void queue
    .add(
      'ig-followup-tick',
      {},
      { repeat: { every: TICK_MS }, removeOnComplete: true, removeOnFail: 20 },
    )
    .catch((err) => console.error('[ig-followup] schedule failed:', err));

  const worker = new Worker(
    QUEUE,
    async (_job: Job) => {
      const { sent } = await runIgFollowUpSweep();
      if (sent > 0) console.log(`[ig-followup] enviou ${sent} cutucada(s)`);
    },
    { connection: bullConnection(), concurrency: 1 },
  );

  worker.on('failed', (_job, err) =>
    console.error('[ig-followup] tick failed:', err),
  );
  console.log('[ig-followup] started — cutucada pós-DM tick a cada 10min');
  return worker;
}
