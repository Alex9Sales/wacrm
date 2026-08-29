// ============================================================
// 📡 Signals worker — tick repetível (30 min) que recomputa os SINAIS de
// recompra de todas as contas com métricas (customer_signals, CDL Fase 7).
// A lógica vive em lib/cdl/signals.ts. Espelha o followup-worker.
// ============================================================

import { Queue, Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { recomputeAllAccountSignals } from '@/lib/cdl/signals';

const SIGNALS_QUEUE = 'cdl-signals';
// Sinais dependem do "agora" (dias sem comprar), mas mudam devagar — 30 min
// é folgado. O sweep é set-based (um statement por conta).
const TICK_MS = 30 * 60_000; // 30 min

export function startSignalsWorker(): Worker {
  const queue = new Queue(SIGNALS_QUEUE, { connection: bullConnection() });

  void (async () => {
    try {
      for (const r of await queue.getRepeatableJobs()) {
        await queue.removeRepeatableByKey(r.key);
      }
      await queue.add(
        'cdl-signals-tick',
        {},
        { repeat: { every: TICK_MS }, removeOnComplete: true, removeOnFail: 20 },
      );
    } catch (err) {
      console.error('[signals] schedule failed:', err);
    }
  })();

  const worker = new Worker(
    SIGNALS_QUEUE,
    async () => {
      try {
        const n = await recomputeAllAccountSignals();
        console.log(`[signals] recomputou sinais de ${n} conta(s)`);
      } catch (err) {
        console.error('[signals] sweep failed:', err);
      }
    },
    { connection: bullConnection(), concurrency: 1 },
  );

  worker.on('failed', (_job, err) => console.error('[signals] tick failed:', err));
  console.log(`[signals] started — tick every ${TICK_MS / 1000}s`);
  return worker;
}
