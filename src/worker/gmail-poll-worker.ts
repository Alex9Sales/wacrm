// ============================================================
// Gmail poll worker — tick repetível (1 min) que lê a INBOX de cada canal
// Gmail conectado (IMAP) e traz as mensagens novas pro inbox. A lógica vive em
// lib/channels/gmail-poll.ts. Espelha o followup-worker.
// ============================================================

import { Queue, Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { runGmailPollSweep } from '@/lib/channels/gmail-poll';

const GMAIL_QUEUE = 'gmail-poll';
const TICK_MS = 60_000; // 1 min

export function startGmailPollWorker(): Worker {
  const queue = new Queue(GMAIL_QUEUE, { connection: bullConnection() });

  void (async () => {
    try {
      for (const r of await queue.getRepeatableJobs()) {
        await queue.removeRepeatableByKey(r.key);
      }
      await queue.add(
        'gmail-poll-tick',
        {},
        { repeat: { every: TICK_MS }, removeOnComplete: true, removeOnFail: 20 },
      );
    } catch (err) {
      console.error('[gmail-poll] schedule failed:', err);
    }
  })();

  const worker = new Worker(
    GMAIL_QUEUE,
    async () => {
      try {
        const { channels, messages } = await runGmailPollSweep();
        if (messages > 0) {
          console.log(`[gmail-poll] ${messages} msg(s) de ${channels} canal(is) Gmail`);
        }
      } catch (err) {
        console.error('[gmail-poll] sweep failed:', err);
      }
    },
    { connection: bullConnection(), concurrency: 1 },
  );

  worker.on('failed', (_job, err) => console.error('[gmail-poll] tick failed:', err));
  console.log(`[gmail-poll] started — tick every ${TICK_MS / 1000}s`);
  return worker;
}
