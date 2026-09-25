// ============================================================
// 🔔 Lembrete da mensalidade — tick de hora em hora.
//
// A rotina só age nos degraus (-5, 0, +3 dias do vencimento) e dentro do
// horário comercial em dia útil, então rodar de hora em hora é suficiente e
// barato: nos outros momentos ela olha e não faz nada.
// ============================================================

import { Queue, Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { runBillingReminders } from '@/lib/billing/reminder-run';

const QUEUE = 'billing-reminders';
const EVERY_MS = Number(process.env.BILLING_REMINDER_EVERY_MS) || 60 * 60_000;

export function startBillingReminderWorker(): Worker {
  const queue = new Queue(QUEUE, { connection: bullConnection() });
  void (async () => {
    try {
      for (const r of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(r.key);
      await queue.add('billing-reminder-tick', {}, { repeat: { every: EVERY_MS }, removeOnComplete: true, removeOnFail: 20 });
    } catch (err) {
      console.error('[billing-reminders] schedule failed:', err);
    }
  })();
  const worker = new Worker(QUEUE, async () => runBillingReminders(), {
    connection: bullConnection(),
    concurrency: 1,
  });
  worker.on('failed', (_job, err) => console.error('[billing-reminders] tick failed:', err));
  console.log(`[billing-reminders] started — tick every ${Math.round(EVERY_MS / 60000)}min`);
  return worker;
}
