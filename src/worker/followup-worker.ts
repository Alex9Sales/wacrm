// ============================================================
// Follow-up worker — tick repetível (5 min) que roda o sweep de follow-up
// inteligente: acha conversas paradas e manda UMA mensagem de reengajamento
// gerada pela IA. A lógica (com todas as travas de segurança) vive em
// lib/ai/followup.ts. Espelha o flow-scheduler-worker.
// ============================================================

import { Queue, Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import {
  runFollowUpSweep,
  runStageFollowUpSweep,
  runMeetingReminderSweep,
} from '@/lib/ai/followup';

const FOLLOWUP_QUEUE = 'ai-followup';
// Tick de 1 min: negócios rápidos (gás) precisam de follow-up quase imediato
// (ex.: cliente sem resposta há 2 min). O scan é account-scoped, indexado e
// capado (PER_AGENT_CAP), então rodar mais vezes é barato.
const TICK_MS = 60_000; // 1 min

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
      // Isola o sweep principal: um erro aqui NÃO pode derrubar o tick nem os
      // sweeps irmãos (etapa / lembretes) abaixo — cada um tem seu try/catch.
      try {
        const { sent, agents } = await runFollowUpSweep();
        if (sent > 0) {
          console.log(`[followup] enviou ${sent} follow-up(s) (${agents} agente(s) ligado(s))`);
        }
      } catch (err) {
        console.error('[followup] sweep principal falhou:', err);
      }
      // Follow-up por ETAPA (Fase E): toque disparado quando o card entra numa
      // etapa configurada (ex.: Agendado → confirmar). Mesmo tick.
      try {
        const stage = await runStageFollowUpSweep();
        if (stage.sent > 0) {
          console.log(`[followup] enviou ${stage.sent} follow-up(s) por etapa`);
        }
      } catch (err) {
        console.error('[followup] stage sweep failed:', err);
      }
      // Lembretes de reunião (ancorados no horário do evento). Mesmo tick.
      try {
        const rem = await runMeetingReminderSweep();
        if (rem.sent > 0) {
          console.log(`[followup] enviou ${rem.sent} lembrete(s) de reunião`);
        }
      } catch (err) {
        console.error('[followup] meeting reminder sweep failed:', err);
      }
    },
    { connection: bullConnection(), concurrency: 1 },
  );

  worker.on('failed', (_job, err) => console.error('[followup] tick failed:', err));
  console.log(`[followup] started — tick every ${TICK_MS / 1000}s`);
  return worker;
}
