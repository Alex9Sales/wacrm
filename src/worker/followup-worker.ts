// ============================================================
// Follow-up worker — tick repetível (5 min) que roda o sweep de follow-up
// inteligente: acha conversas paradas e manda UMA mensagem de reengajamento
// gerada pela IA. A lógica (com todas as travas de segurança) vive em
// lib/ai/followup.ts. Espelha o flow-scheduler-worker.
// ============================================================

import { Queue, Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { runFollowUpSweep } from '@/lib/ai/followup';

const FOLLOWUP_QUEUE = 'ai-followup';
const TICK_MS = 5 * 60_000; // 5 min

export function startFollowupWorker(): Worker {
  const queue = new Queue(FOLLOWUP_QUEUE, { connection: bullConnection() });

  void (async () => {
    try {
      for (const r of await queue.getRepeatableJobs()) {
        await queue.removeRepeatableByKey(r.key);
      }
      await queue.add(
        'ai-followup-tick',
        {},
        { repeat: { every: TICK_MS }, removeOnComplete: true, removeOnFail: 20 },
      );
    } catch (err) {
      console.error('[followup] schedule failed:', err);
    }
  })();

  const worker = new Worker(
    FOLLOWUP_QUEUE,
    async () => {
      const { sent, agents } = await runFollowUpSweep();
      if (sent > 0) {
        console.log(`[followup] enviou ${sent} follow-up(s) (${agents} agente(s) ligado(s))`);
      }
    },
    { connection: bullConnection(), concurrency: 1 },
  );

  worker.on('failed', (_job, err) => console.error('[followup] tick failed:', err));
  console.log(`[followup] started — tick every ${TICK_MS / 1000}s`);
  return worker;
}
