// ============================================================
// ⏰ Transferência parada — tick a cada 2 min (02/10/2026).
//
// Para cada conta com o aviso ligado (Config → Negócios → Avisos do
// responsável), avisa UMA vez a transferência da IA que passou de N minutos de
// expediente sem ninguém da equipe responder. A lógica (travas, janela, teto)
// vive em lib/alerts/aviso-transferencia-parada.ts; aqui só o relógio.
//
// Sem 'server-only' em nada daqui para baixo: o worker não tem esse pacote.
// ============================================================

import { Queue, Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { varrerTransferenciasParadas } from '@/lib/alerts/aviso-transferencia-parada';

const QUEUE = 'handoff-stalled';
export const EVERY_MS = Number(process.env.HANDOFF_STALLED_EVERY_MS) || 2 * 60_000;

/** Um tick: varre as contas e só fala no log quando avisou ou falhou. */
export async function tickDaTransferenciaParada(): Promise<
  Awaited<ReturnType<typeof varrerTransferenciasParadas>>
> {
  const r = await varrerTransferenciasParadas();
  if (r.avisos || r.erros) {
    console.log(
      `[handoff-stalled] tick: ${r.contas} conta(s), ${r.avisos} aviso(s), ${r.erros} com erro`,
    );
  }
  return r;
}

export function startHandoffStalledWorker(): Worker {
  const queue = new Queue(QUEUE, { connection: bullConnection() });
  void (async () => {
    try {
      // Troca o agendamento antigo (um EVERY_MS diferente criaria um segundo
      // repetível em vez de substituir o primeiro).
      for (const r of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(r.key);
      await queue.add(
        'handoff-stalled-tick',
        {},
        { repeat: { every: EVERY_MS }, removeOnComplete: true, removeOnFail: 20 },
      );
    } catch (err) {
      console.error('[handoff-stalled] schedule failed:', err);
    }
  })();
  // concurrency 1: dois ticks juntos leriam a mesma transferência antes de a
  // nota-trava do primeiro existir — e o dono receberia o aviso em dobro.
  const worker = new Worker(QUEUE, () => tickDaTransferenciaParada(), {
    connection: bullConnection(),
    concurrency: 1,
  });
  worker.on('failed', (_job, err) => console.error('[handoff-stalled] tick failed:', err));
  console.log(`[handoff-stalled] started — tick every ${Math.round(EVERY_MS / 1000)}s`);
  return worker;
}
