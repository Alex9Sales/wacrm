// ============================================================
// 🧠 Fase 2 — tick de orquestração (10 min): recomputa os sinais de negócio
// (proposal_idle, followup_due, stale_deal, high_intent, churn_risk…) e roda o
// motor Signal → Policy → Action por conta. Cada conta é isolada (uma falha não
// derruba o tick). Lógica em lib/orchestration/*.
// ============================================================
import { Queue, Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import type { OrchestrationNudgeJob } from '@/lib/queue/queues';
import { listOrchestrationAccounts, recomputeOrchestrationSignals } from '@/lib/orchestration/deal-signals';
import { runOrchestrationForAccount } from '@/lib/orchestration/engine';
import { accountsWithCollections, runCollectionsForAccount } from '@/lib/collections/engine';

const QUEUE = 'orchestration';
const TICK_MS = 10 * 60_000;

export async function tick(): Promise<void> {
  const accounts = await listOrchestrationAccounts();
  for (const accountId of accounts) {
    try {
      await recomputeOrchestrationSignals(accountId);
    } catch (err) {
      console.error('[orchestration] sinais falharam:', accountId.slice(0, 8), err instanceof Error ? err.message : err);
      continue;
    }
    try {
      const s = await runOrchestrationForAccount(accountId);
      if (s.auto || s.approvals || s.suggestions || s.blocked || s.failed) {
        console.log(
          `[orchestration] ${accountId.slice(0, 8)}: sinais=${s.signals} auto=${s.auto} aprovações=${s.approvals} sugestões=${s.suggestions} bloqueadas=${s.blocked} falhas=${s.failed}${s.skipped ? ` (${s.skipped})` : ''}`,
        );
      }
    } catch (err) {
      console.error('[orchestration] motor falhou:', accountId.slice(0, 8), err instanceof Error ? err.message : err);
    }
  }

  // 🧾 Régua de cobrança. Roda no mesmo tique porque as travas dela são
  // próprias: a janela de horário, o intervalo por devedor e o teto diário
  // barram sozinhos — e a leitura do Asaas só acontece se a última tiver mais
  // de uma hora, para não estourar o limite de requisições deles.
  let cobrancaAccounts: string[] = [];
  try {
    cobrancaAccounts = await accountsWithCollections();
  } catch (err) {
    console.error('[cobranca] não deu pra listar contas:', err instanceof Error ? err.message : err);
  }
  for (const accountId of cobrancaAccounts) {
    try {
      const c = await runCollectionsForAccount(accountId);
      if (c.queued) {
        const pulados = Object.entries(c.skipped).map(([k, v]) => `${k}=${v}`).join(' ');
        console.log(`[cobranca] ${accountId.slice(0, 8)}: devedores=${c.debtors} na fila=${c.queued}${pulados ? ` pulados(${pulados})` : ''}`);
      }
    } catch (err) {
      console.error('[cobranca] régua falhou:', accountId.slice(0, 8), err instanceof Error ? err.message : err);
    }
  }
}

/** Uma conta só, disparada por EVENTO (cliente respondeu, aprovação decidida…). */
export async function runNudge(accountId: string, reason: string): Promise<void> {
  try {
    await recomputeOrchestrationSignals(accountId);
  } catch (err) {
    console.error('[orchestration] nudge: sinais falharam:', accountId.slice(0, 8), err instanceof Error ? err.message : err);
    return;
  }
  try {
    const s = await runOrchestrationForAccount(accountId);
    console.log(
      `[orchestration] nudge(${reason}) ${accountId.slice(0, 8)}: sinais=${s.signals} auto=${s.auto} aprovações=${s.approvals} sugestões=${s.suggestions}`,
    );
  } catch (err) {
    console.error('[orchestration] nudge: motor falhou:', accountId.slice(0, 8), err instanceof Error ? err.message : err);
  }
}

export function startOrchestrationWorker(): Worker {
  const queue = new Queue(QUEUE, { connection: bullConnection() });
  void (async () => {
    try {
      for (const r of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(r.key);
      await queue.add('orchestration-tick', {}, { repeat: { every: TICK_MS }, removeOnComplete: true, removeOnFail: 20 });
    } catch (err) {
      console.error('[orchestration] schedule failed:', err);
    }
  })();
  const worker = new Worker<OrchestrationNudgeJob | Record<string, never>>(
    QUEUE,
    async (job) => {
      // 'nudge' = evento de UMA conta; qualquer outro nome = tick de todas.
      if (job.name === 'nudge') {
        const data = job.data as OrchestrationNudgeJob;
        if (data?.accountId) await runNudge(data.accountId, data.reason || 'evento');
        return;
      }
      await tick();
    },
    { connection: bullConnection(), concurrency: 1 },
  );
  worker.on('failed', (_job, err) => console.error('[orchestration] tick failed:', err));
  console.log(`[orchestration] started — tick every ${TICK_MS / 60000}min`);
  return worker;
}
