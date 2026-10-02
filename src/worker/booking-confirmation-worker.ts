// ============================================================
// ⏳ Confirmação ao agendar — tick a cada 30 s (02/10/2026).
//
// O salvar na Agenda não manda mais a confirmação na hora: põe na fila
// (`calendar_events.confirmation_due_at`, migração 0204) para uns minutos
// depois do ÚLTIMO salvar. Este tick pega as vencidas e manda só a versão
// final — um compromisso criado no horário errado e corrigido em seguida
// mandava três mensagens seguidas ao paciente. Ver
// lib/agenda/confirmacao-fila.ts (a fila) e confirmacao-envio.ts (o envio).
//
// Sem 'server-only' em nada daqui para baixo: o worker não tem esse pacote.
// ============================================================

import { Queue, Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { processarConfirmacoesVencidas } from '@/lib/agenda/confirmacao-fila';

const QUEUE = 'booking-confirmation';
export const EVERY_MS = Number(process.env.BOOKING_CONFIRMATION_EVERY_MS) || 30_000;

/** Um tick: resolve as vencidas e só fala no log quando algo não saiu. */
export async function tickDaConfirmacao(): Promise<Awaited<ReturnType<typeof processarConfirmacoesVencidas>>> {
  const r = await processarConfirmacoesVencidas();
  if (r.naoEnviadas || r.erros) {
    console.warn(
      `[booking-confirmation] tick: ${r.lidas} vencida(s), ${r.enviadas} enviada(s), ` +
        `${r.naoEnviadas} não enviada(s), ${r.erros} com erro`,
    );
  }
  return r;
}

export function startBookingConfirmationWorker(): Worker {
  const queue = new Queue(QUEUE, { connection: bullConnection() });
  void (async () => {
    try {
      for (const r of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(r.key);
      await queue.add(
        'booking-confirmation-tick',
        {},
        { repeat: { every: EVERY_MS }, removeOnComplete: true, removeOnFail: 20 },
      );
    } catch (err) {
      console.error('[booking-confirmation] schedule failed:', err);
    }
  })();
  // concurrency 1: um tick por vez. As confirmações saem em ordem, e a cópia
  // da mesma consulta em outra agenda só é julgada depois da primeira.
  const worker = new Worker(QUEUE, () => tickDaConfirmacao(), { connection: bullConnection(), concurrency: 1 });
  worker.on('failed', (_job, err) => console.error('[booking-confirmation] tick failed:', err));
  console.log(`[booking-confirmation] started — tick every ${Math.round(EVERY_MS / 1000)}s`);
  return worker;
}
