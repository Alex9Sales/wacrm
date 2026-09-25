// ============================================================
// 🐢 Worker da ferramenta LENTA.
//
// Um job por consulta que não coube no turno. Ele faz a chamada com prazo
// próprio (até 2 min) e devolve a resposta como mensagem nova na conversa.
//
// Concorrência baixa de propósito: cada job segura uma conexão aberta por
// muito tempo, e o volume aqui é de pergunta humana, não de rajada.
// ============================================================

import { Worker } from 'bullmq';

import { runSlowTool } from '@/lib/ai/slow-tool';
import { bullConnection } from '@/lib/queue/connection';
import { SLOW_TOOL_QUEUE, type SlowToolJob } from '@/lib/queue/queues';

function log(...args: unknown[]) {
  console.log('[slow-tool-worker]', ...args);
}

export function startSlowToolWorker(): Worker<SlowToolJob> {
  const worker = new Worker<SlowToolJob>(
    SLOW_TOOL_QUEUE,
    async (job) => {
      const out = await runSlowTool(job.data);
      log(
        `${job.data.conversationId}: ${out.sent ? 'respondido' : `não respondido — ${out.why}`}`,
      );
    },
    {
      connection: bullConnection(),
      concurrency: 2,
      // O job fica vivo enquanto a API lenta não responde; sem folga aqui o
      // BullMQ daria a tarefa como perdida no meio da consulta.
      lockDuration: 180_000,
    },
  );
  worker.on('failed', (job, err) =>
    log(`${job?.data.conversationId} falhou:`, err?.message),
  );
  worker.on('error', (err) => log('erro do worker:', err.message));
  log(`ouvindo '${SLOW_TOOL_QUEUE}'.`);
  return worker;
}
