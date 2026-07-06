// ============================================================
// Scheduled-message worker (per-conversation "Agendar mensagem").
//
// A delayed BullMQ job (queue 'scheduled-message', jobId `sched-{id}`)
// fires at the row's scheduled_at. This processor:
//   - reloads the scheduled_messages row (fresh state after a restart),
//   - skips if it's no longer 'pending' (cancelled / already sent / failed),
//   - sends it via the SAME funnel the inbox composer uses
//     (sendMessageToConversation — provider-agnostic, Next-independent),
//   - flips the row to 'sent' (+ ids) and publishes a realtime event so
//     the inbox shows the message immediately.
//
// Error handling mirrors the recipient worker: a permanent failure
// (validation / capability / undeliverable, or a post-send DB error where
// retrying would double-send) marks 'failed' with UnrecoverableError; a
// transient one throws so BullMQ retries with backoff, and marks 'failed'
// only once retries are exhausted.
//
// Next-independent: sendMessageToConversation and publishEvent pull only
// Drizzle / providers / ioredis — never next/headers or after().
// ============================================================

import { Worker, UnrecoverableError, type Job } from 'bullmq';
import { eq, and } from 'drizzle-orm';

import { db, scheduledMessages } from '@/db';
import { bullConnection } from '@/lib/queue/connection';
import {
  SCHEDULED_MESSAGE_QUEUE,
  type ScheduledMessageJob,
} from '@/lib/queue/queues';
import { isPermanentSendError } from '@/lib/queue/errors';
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import { publishEvent } from '@/lib/events/publish';

function log(...args: unknown[]): void {
  console.log('[worker:scheduled]', ...args);
}

/** True when the failure will never succeed on retry → mark 'failed', no retry. */
function isPermanentScheduleError(err: unknown): boolean {
  if (err instanceof SendMessageError) {
    // 4xx = client/validation/capability error — structurally can't succeed.
    if (err.status < 500) return true;
    // db_error: the send likely reached the provider but persistence failed;
    // retrying would double-send, so treat as permanent.
    if (err.code === 'db_error') return true;
    // 5xx provider send error — permanent only if the provider text says so.
    return isPermanentSendError(err.message);
  }
  return false;
}

async function processScheduledMessageJob(
  job: Job<ScheduledMessageJob>,
): Promise<void> {
  const { scheduledMessageId } = job.data;

  const row = (
    await db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.id, scheduledMessageId))
      .limit(1)
  )[0];

  if (!row) {
    log(`${scheduledMessageId} skipped: row missing (deleted)`);
    return;
  }
  if (row.status !== 'pending') {
    log(`${scheduledMessageId} skipped: status ${row.status}`);
    return;
  }

  const attempts = row.attempts + 1;
  const now = new Date().toISOString();

  try {
    const result = await sendMessageToConversation(row.accountId, {
      conversationId: row.conversationId,
      messageType: row.messageType,
      contentText: row.contentText,
      mediaUrl: row.mediaUrl,
      filename: row.filename,
    });

    // Guard on status='pending' so a race with a cancel doesn't resurrect it
    // — though once sent, 'sent' is the accurate terminal state.
    await db
      .update(scheduledMessages)
      .set({
        status: 'sent',
        sentMessageId: result.messageId,
        externalMessageId: result.whatsappMessageId,
        attempts,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(scheduledMessages.id, scheduledMessageId));

    // Best-effort realtime nudge so the inbox renders the new message.
    await publishEvent(row.accountId, {
      type: 'message.received',
      conversationId: row.conversationId,
    });

    log(`${scheduledMessageId} sent → ${result.whatsappMessageId}`);
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await db
      .update(scheduledMessages)
      .set({ attempts, lastError: message, updatedAt: now })
      .where(eq(scheduledMessages.id, scheduledMessageId));

    if (isPermanentScheduleError(err)) {
      await db
        .update(scheduledMessages)
        .set({ status: 'failed', updatedAt: now })
        .where(
          and(
            eq(scheduledMessages.id, scheduledMessageId),
            eq(scheduledMessages.status, 'pending'),
          ),
        );
      log(`${scheduledMessageId} PERMANENT failure: ${message}`);
      throw new UnrecoverableError(message);
    }

    const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (isLastAttempt) {
      await db
        .update(scheduledMessages)
        .set({ status: 'failed', updatedAt: now })
        .where(
          and(
            eq(scheduledMessages.id, scheduledMessageId),
            eq(scheduledMessages.status, 'pending'),
          ),
        );
      log(`${scheduledMessageId} failed (retries exhausted): ${message}`);
    } else {
      log(`${scheduledMessageId} transient failure, will retry: ${message}`);
    }
    throw err;
  }
}

/**
 * Start the scheduled-message worker. Returned so the bootstrap can close
 * it on graceful shutdown alongside the broadcast workers.
 */
export function startScheduledMessageWorker(): Worker<ScheduledMessageJob> {
  const worker = new Worker<ScheduledMessageJob>(
    SCHEDULED_MESSAGE_QUEUE,
    (job) => processScheduledMessageJob(job),
    { connection: bullConnection(), concurrency: 4 },
  );
  worker.on('completed', (job) =>
    log(`${job.data.scheduledMessageId} done`),
  );
  worker.on('failed', (job, err) =>
    log(`${job?.data.scheduledMessageId} failed:`, err?.message),
  );
  worker.on('error', (err) => log('worker error:', err.message));
  log(`listening on '${SCHEDULED_MESSAGE_QUEUE}'.`);
  return worker;
}
