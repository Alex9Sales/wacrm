// ============================================================
// 🧾 Sender da régua de cobrança — a cada MINUTO, por conta com régua ligada,
// manda a próxima cobrança devida se já passou a cadência ("uma mensagem a
// cada N minutos", Cobranças → Ajustar). Separado do tique de orquestração
// (10 min) de propósito: cadência de 5 min não cabe num tique de 10, e um
// tique longo (IA redigindo 30 textos) não pode segurar o envio.
// Lógica em lib/collections/sender.ts.
// ============================================================
import { Queue, Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { accountsWithCollections } from '@/lib/collections/engine';
import { sendDueAutoCollections } from '@/lib/collections/sender';
import { sendDuePaymentThanks } from '@/lib/collections/thanks';

const QUEUE = 'collections-sender';
const EVERY_MS = Number(process.env.COLLECTIONS_SENDER_EVERY_MS) || 60_000;

export async function tick(): Promise<void> {
  let accounts: string[] = [];
  try {
    accounts = await accountsWithCollections();
  } catch (err) {
    console.error('[cobranca-sender] não deu pra listar contas:', err instanceof Error ? err.message : err);
    return;
  }
  for (const accountId of accounts) {
    try {
      const r = await sendDueAutoCollections(accountId);
      if (r.sent || r.failed) {
        console.log(`[cobranca-sender] ${accountId.slice(0, 8)}: enviadas=${r.sent} falhas=${r.failed}${r.haltedBecause ? ` (${r.haltedBecause})` : ''}`);
      }
      // 🙏 11/09 (Alex): o agradecimento de pagamento também respeita a janela.
      // O que chegou fora dela ficou esperando — uma por tique, pra um fim de
      // semana inteiro não virar rajada na segunda de manhã.
      const t = await sendDuePaymentThanks(accountId);
      if (t.sent) console.log(`[cobranca-sender] ${accountId.slice(0, 8)}: agradecimento em espera enviado (${t.why})`);
    } catch (err) {
      console.error('[cobranca-sender] falhou:', accountId.slice(0, 8), err instanceof Error ? err.message : err);
    }
  }
}

export function startCollectionsSenderWorker(): Worker {
  const queue = new Queue(QUEUE, { connection: bullConnection() });
  void (async () => {
    try {
      for (const r of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(r.key);
      await queue.add('collections-sender-tick', {}, { repeat: { every: EVERY_MS }, removeOnComplete: true, removeOnFail: 20 });
    } catch (err) {
      console.error('[cobranca-sender] schedule failed:', err);
    }
  })();
  const worker = new Worker(QUEUE, async () => tick(), { connection: bullConnection(), concurrency: 1 });
  worker.on('failed', (_job, err) => console.error('[cobranca-sender] tick failed:', err));
  console.log(`[cobranca-sender] started — every ${Math.round(EVERY_MS / 1000)}s`);
  return worker;
}
