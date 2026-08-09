// ============================================================
// Worker de sugestões proativas (IA v2 — Fase 3).
//
// Mensagens do cliente enfileiram um job DEBOUNCED (jobId por conversa) que só
// dispara depois de `DEAL_SUGGEST_BUFFER_SECONDS` de silêncio. Este worker roda
// esse job: acha o negócio ABERTO vinculado à conversa e, respeitando os gates
// de custo (não empilha pendentes; cooldown por negócio), pede à IA para propor
// campos + próximo passo. Tudo fica como SUGESTÃO — o humano confirma no card.
//
// Os gates vivem dentro de `runProactiveDealSuggestions` e são checados AQUI, na
// hora de disparar — então o buffer nunca gera análise duplicada por rajada.
// ============================================================

import { Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { DEAL_SUGGEST_QUEUE, type DealSuggestJob } from '@/lib/queue/queues';
import { runProactiveDealSuggestions } from '@/lib/ai/deal-suggest';

function log(...args: unknown[]) {
  console.log('[deal-suggest-worker]', ...args);
}

export function startDealSuggestWorker(): Worker<DealSuggestJob> {
  const worker = new Worker<DealSuggestJob>(
    DEAL_SUGGEST_QUEUE,
    async (job) => {
      await runProactiveDealSuggestions(job.data);
    },
    { connection: bullConnection(), concurrency: 2 },
  );
  worker.on('failed', (job, err) =>
    log(`${job?.data.conversationId} failed:`, err?.message),
  );
  worker.on('error', (err) => log('worker error:', err.message));
  log(`listening on '${DEAL_SUGGEST_QUEUE}'.`);
  return worker;
}
