// ============================================================
// Broadcast queue worker (Phase 5 CORE).
//
// A PLAIN node process (run via `tsx src/worker/index.ts`), NOT Next.js.
// It must never import anything that pulls `next/headers` or `after()` —
// the channel send path (getProvider, channels.ts, providers/*, db) is
// Next-independent, and every helper this file imports has been kept so.
//
// Env (.env.local) is loaded by the bootstrap `src/worker/index.ts`
// BEFORE this module is imported — necessary because ESM hoists imports,
// and encryption.ts reads ENCRYPTION_KEY at module-eval time.
//
// Two worker tiers:
//
//   dispatch worker  (queue 'broadcast-dispatch')
//     One job per broadcast. Loads it, skips if cancelled, marks it
//     'sending', and enqueues each pending recipient onto the channel's
//     outbound queue (jobId = recipientRowId → idempotent).
//
//   recipient workers (queues 'outbound-{channelId}')
//     Created on demand, one per active channel, each with that
//     channel's throughput limiter. A job:
//       - reloads the recipient + broadcast (fresh state after restart),
//       - broadcast cancelled → skip (ack, no send),
//       - broadcast paused    → moveToDelayed(+15s) so it self-resumes,
//       - broadcast sending   → jitter (non-official providers) then send;
//           success → mark 'sent' + wamid; permanent error → mark 'failed'
//           (UnrecoverableError, no retry); transient → throw to retry.
//
// Idempotency: jobId=recipientRowId means an infra retry of dispatch
// never double-sends. DRY_RUN (BROADCAST_DRY_RUN=true) simulates success
// with a fake wamid so the whole pipeline can be exercised offline.
// ============================================================

import { Worker, UnrecoverableError, type Job } from 'bullmq';

import { bullConnection, createRedisClient } from '@/lib/queue/connection';
import {
  BROADCAST_DISPATCH_QUEUE,
  outboundQueueName,
  enqueueRecipient,
  type BroadcastDispatchJob,
  type RecipientJob,
} from '@/lib/queue/queues';
import { limiterForChannel, jitterForChannel } from '@/lib/queue/throughput';
import { isPermanentSendError } from '@/lib/queue/errors';
import {
  loadBroadcastRow,
  resolveBroadcastChannel,
  markBroadcastSending,
  listPendingRecipientIds,
  loadRecipientJobContext,
  markRecipientSent,
  recordRecipientAttempt,
  markRecipientFailed,
  finalizeBroadcastIfDone,
} from '@/lib/queue/broadcast-jobs';
import { getProvider } from '@/lib/channels/registry';
import { sendBroadcastRecipient } from '@/lib/whatsapp/broadcast-core';

const DRY_RUN = process.env.BROADCAST_DRY_RUN === 'true';
const PAUSE_RECHECK_MS = 15_000;

function log(...args: unknown[]): void {
  console.log('[worker]', ...args);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rand(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

// A raw ioredis client for direct Redis calls (startup KEYS scan). The
// Workers below take BullMQ connection options, not this instance.
const rawRedis = createRedisClient();

// ---- dynamic per-channel recipient workers -----------------------------
// One Worker per channelId, spun up on demand by the dispatch worker (or
// lazily the first time a recipient job for that channel is seen). Each
// carries the channel's throughput limiter.
const recipientWorkers = new Map<string, Worker<RecipientJob>>();

async function ensureRecipientWorker(channelId: string): Promise<void> {
  if (recipientWorkers.has(channelId)) return;

  // Resolve the channel's limiter up front. We need a channel ctx for the
  // limiter; load any broadcast's channel via a throwaway resolve isn't
  // available here, so load the channel directly.
  const { loadChannel } = await import('@/lib/channels/channels');
  const channel = await loadChannel(channelId);
  const limiter = channel
    ? limiterForChannel(channel)
    : { max: 10, duration: 60_000 };

  const worker = new Worker<RecipientJob>(
    outboundQueueName(channelId),
    (job) => processRecipientJob(job),
    {
      connection: bullConnection(),
      limiter: { max: limiter.max, duration: limiter.duration },
      // One in-flight send at a time per channel; the limiter caps the
      // rate. Concurrency>1 would let bursts beat the limiter window.
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    log(
      `recipient job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err?.message,
    );
  });
  worker.on('error', (err) => log('recipient worker error:', err.message));

  recipientWorkers.set(channelId, worker);
  log(
    `spun up recipient worker for channel ${channelId} ` +
      `(limit ${limiter.max}/${Math.round(limiter.duration / 1000)}s)`,
  );
}

// ---- recipient job -----------------------------------------------------
async function processRecipientJob(job: Job<RecipientJob>): Promise<void> {
  const { recipientRowId } = job.data;
  const loaded = await loadRecipientJobContext(recipientRowId);

  if (loaded.kind === 'missing') {
    // Nothing to send — ack so it doesn't retry forever.
    log(`recipient ${recipientRowId} skipped: ${loaded.reason}`);
    return;
  }

  if (loaded.kind === 'broadcast') {
    const status = loaded.broadcast.status;
    if (status === 'cancelled') {
      log(`recipient ${recipientRowId} skipped: broadcast cancelled`);
      return; // ack, no send
    }
    if (status === 'paused') {
      // Re-check later so a resume naturally picks it back up.
      await job.moveToDelayed(Date.now() + PAUSE_RECHECK_MS, job.token);
      log(`recipient ${recipientRowId} deferred: broadcast paused`);
      return;
    }
    // Any other non-sending terminal state (sent/failed) → nothing to do.
    log(`recipient ${recipientRowId} skipped: broadcast status ${status}`);
    return;
  }

  const { channel, sendContext, recipient } = loaded.ctx;
  const attempts = recipient.attempts + 1;

  // Jitter for non-official providers to reduce ban risk.
  const jitter = jitterForChannel({
    settings: channel.settings,
    needsJitter: getProvider(channel.provider).capabilities.needsJitter,
  });
  if (jitter) {
    const delay = rand(jitter[0], jitter[1]);
    await sleep(delay);
  }

  // DRY_RUN — simulate a successful send without touching the provider.
  if (DRY_RUN) {
    const wamid = `dry-${recipient.id}`;
    await markRecipientSent(recipient.id, wamid, attempts);
    log(`DRY_RUN sent recipient ${recipient.id} → ${wamid}`);
    await finalizeBroadcastIfDone(loaded.ctx.broadcast.id);
    return;
  }

  const result = await sendBroadcastRecipient(channel, sendContext, {
    phone: recipient.phone,
    params: recipient.params,
    messageParams: recipient.messageParams,
  });

  if (result.ok) {
    await markRecipientSent(recipient.id, result.externalMessageId, attempts);
    log(`sent recipient ${recipient.id} → ${result.externalMessageId}`);
    await finalizeBroadcastIfDone(loaded.ctx.broadcast.id);
    return;
  }

  // Failure — classify.
  if (isPermanentSendError(result.error)) {
    await markRecipientFailed(recipient.id, attempts, result.error);
    log(`recipient ${recipient.id} PERMANENT failure: ${result.error}`);
    await finalizeBroadcastIfDone(loaded.ctx.broadcast.id);
    // No retry.
    throw new UnrecoverableError(result.error);
  }

  // Transient — record the attempt and let BullMQ retry with backoff.
  await recordRecipientAttempt(recipient.id, attempts, result.error);
  const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  if (isLastAttempt) {
    await markRecipientFailed(recipient.id, attempts, result.error);
    log(`recipient ${recipient.id} failed (retries exhausted): ${result.error}`);
    await finalizeBroadcastIfDone(loaded.ctx.broadcast.id);
  } else {
    log(`recipient ${recipient.id} transient failure, will retry: ${result.error}`);
  }
  throw new Error(result.error);
}

// ---- dispatch job ------------------------------------------------------
async function processDispatchJob(job: Job<BroadcastDispatchJob>): Promise<void> {
  const { broadcastId } = job.data;
  const broadcast = await loadBroadcastRow(broadcastId);
  if (!broadcast) {
    log(`dispatch ${broadcastId} skipped: broadcast not found`);
    return;
  }
  if (broadcast.status === 'cancelled') {
    log(`dispatch ${broadcastId} skipped: cancelled`);
    return;
  }

  const channel = await resolveBroadcastChannel(broadcast);
  if (!channel) {
    log(`dispatch ${broadcastId} skipped: no channel resolvable`);
    return;
  }

  await markBroadcastSending(broadcastId);
  await ensureRecipientWorker(channel.id);

  const pending = await listPendingRecipientIds(broadcastId);
  log(
    `dispatch ${broadcastId}: enqueueing ${pending.length} recipients on ` +
      `channel ${channel.id}`,
  );
  for (const recipientRowId of pending) {
    await enqueueRecipient(channel.id, { broadcastId, recipientRowId });
  }
  // Nothing pending (all already settled) → finalize.
  await finalizeBroadcastIfDone(broadcastId);
}

// ---- dispatch worker ---------------------------------------------------
const dispatchWorker = new Worker<BroadcastDispatchJob>(
  BROADCAST_DISPATCH_QUEUE,
  (job) => processDispatchJob(job),
  { connection: bullConnection(), concurrency: 4 },
);
dispatchWorker.on('completed', (job) =>
  log(`dispatch ${job.data.broadcastId} done`),
);
dispatchWorker.on('failed', (job, err) =>
  log(`dispatch ${job?.data.broadcastId} failed:`, err?.message),
);
dispatchWorker.on('error', (err) => log('dispatch worker error:', err.message));

log(`started. DRY_RUN=${DRY_RUN}. Listening on '${BROADCAST_DISPATCH_QUEUE}'.`);

// ---- startup recovery --------------------------------------------------
// On restart, recipient jobs enqueued by a prior run still sit in their
// `outbound-{channelId}` queues but have no consumer until a fresh
// dispatch spins one up. Scan Redis for existing outbound queues and
// (re)attach a worker to each so in-flight sends resume immediately.
async function recoverOutboundWorkers(): Promise<void> {
  try {
    const keys = await rawRedis.keys('bull:outbound-*:meta');
    const channelIds = new Set<string>();
    for (const key of keys) {
      // key = bull:outbound-{channelId}:meta
      const m = key.match(/^bull:outbound-([^:]+):meta$/);
      if (m) channelIds.add(m[1]);
    }
    for (const channelId of channelIds) {
      await ensureRecipientWorker(channelId);
    }
    if (channelIds.size > 0) {
      log(`recovered ${channelIds.size} outbound worker(s) on startup`);
    }
  } catch (err) {
    log('recovery error:', err instanceof Error ? err.message : err);
  }
}
void recoverOutboundWorkers();

// ---- graceful shutdown -------------------------------------------------
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received — closing workers…`);
  try {
    await dispatchWorker.close();
    await Promise.all([...recipientWorkers.values()].map((w) => w.close()));
    await rawRedis.quit();
  } catch (err) {
    log('shutdown error:', err instanceof Error ? err.message : err);
  }
  log('closed. bye.');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
