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
//       - já recebeu a mesma mensagem por OUTRO disparo nas últimas 24 h e o
//         disparo não tem allow_repeats → 'failed' com o motivo (revisão
//         15/09: disparo pausado que volta depois de outro igual),
//       - broadcast sending   → jitter (non-official providers) then send;
//           success → mark 'sent' + wamid (+ quem disparou vira participante
//           da conversa, 15/09); permanent error → mark 'failed'
//           (UnrecoverableError, no retry); transient → throw to retry.
//
// Idempotency: jobId=recipientRowId means an infra retry of dispatch
// never double-sends. DRY_RUN (BROADCAST_DRY_RUN=true) simulates success
// with a fake wamid so the whole pipeline can be exercised offline.
// ============================================================

import { Worker, UnrecoverableError, DelayedError, type Job } from 'bullmq';

import { bullConnection, createRedisClient } from '@/lib/queue/connection';
import {
  BROADCAST_DISPATCH_QUEUE,
  outboundQueueName,
  enqueueRecipient,
  type BroadcastDispatchJob,
  type RecipientJob,
} from '@/lib/queue/queues';
import { limiterForChannel, jitterForChannel } from '@/lib/queue/throughput';
import { channelHaltReason, isPermanentSendError } from '@/lib/queue/errors';
import { haltBroadcast } from '@/lib/queue/broadcast-controls';
import {
  loadBroadcastRow,
  resolveBroadcastChannel,
  markBroadcastSending,
  listPendingRecipientSlots,
  loadRecipientJobContext,
  markRecipientSent,
  recordRecipientAttempt,
  markRecipientFailed,
  finalizeBroadcastIfDone,
  type RecipientJobContext,
} from '@/lib/queue/broadcast-jobs';
import {
  normalizePacing,
  computeDripSlots,
  localMinuteOfDay,
  localWeekday,
  type PacingConfig,
} from '@/lib/whatsapp/drip-schedule';
import { getProvider } from '@/lib/channels/registry';
import { sendBroadcastRecipient } from '@/lib/whatsapp/broadcast-core';
import { linkBroadcastConversation } from '@/lib/broadcasts/conversation-link';
import {
  ALREADY_RECEIVED_ELSEWHERE_ERROR,
  contactAlreadyReceivedElsewhere,
} from '@/lib/broadcasts/duplicate-sends';
import { startScheduledMessageWorker } from './scheduled-message-worker';

const DRY_RUN = process.env.BROADCAST_DRY_RUN === 'true';
const PAUSE_RECHECK_MS = 15_000;
/** Job que acorda até 2 s antes do horário gravado segue (relógio/atraso do Redis). */
const SLOT_EARLY_TOLERANCE_MS = 2_000;

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

/**
 * Revisão 15/09 (GoLink): disparo A pausado com pendentes + disparo B com a
 * mesma mensagem → quando A volta, os pendentes recebiam de novo (na criação
 * de B, A pausado não contava como "na fila"). Confere na hora, com UMA
 * consulta, se o contato já recebeu a mesma mensagem por outro disparo nas
 * últimas 24 h. Fica fora: disparo com "enviar também pra quem já recebeu"
 * (allow_repeats) e destinatário com mensagem própria (vars). Consulta falhou
 * → segue enviando (melhor mandar do que travar o disparo).
 */
async function alreadyReceivedElsewhere(ctx: RecipientJobContext): Promise<boolean> {
  const { broadcast, recipient } = ctx;
  if (broadcast.allowRepeats || !recipient.contactId || recipient.hasOwnVars) return false;
  try {
    return await contactAlreadyReceivedElsewhere({
      accountId: broadcast.accountId,
      broadcastId: broadcast.id,
      contactId: recipient.contactId,
      messageKind: broadcast.messageKind,
      bodyText: broadcast.bodyText,
      subject: broadcast.subject,
      // Família do canal: e-mail só compara com e-mail (conferência 15/09).
      emailChannel: ctx.channel.provider === 'email' || ctx.channel.provider === 'gmail',
      media: broadcast.media,
      mediaUrl: broadcast.mediaUrl,
      mediaFilename: broadcast.mediaFilename,
      templateName: broadcast.templateName,
      templateLanguage: broadcast.templateLanguage,
      params: recipient.params,
      messageParams: recipient.messageParams ?? null,
    });
  } catch (err) {
    log(
      `recipient ${recipient.id} checagem de repetido falhou — segue enviando:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
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
      // Re-check later so a resume naturally picks it back up. Depois de
      // moveToDelayed é OBRIGATÓRIO lançar DelayedError — se der `return`, o
      // Worker tenta moveToFinished num job cujo lock já foi consumido →
      // "Missing lock for job … moveToFinished" (flood). [BullMQ v5]
      await job.moveToDelayed(Date.now() + PAUSE_RECHECK_MS, job.token);
      log(`recipient ${recipientRowId} deferred: broadcast paused`);
      throw new DelayedError();
    }
    // Any other non-sending terminal state (sent/failed) → nothing to do.
    log(`recipient ${recipientRowId} skipped: broadcast status ${status}`);
    return;
  }

  const { channel, sendContext, recipient } = loaded.ctx;
  // Job idempotente (revisão 15/09): ao retomar, um job já concluído pode ser
  // reagendado com o mesmo id se o envio terminou no meio do reslot — sem
  // isso o cliente receberia de novo.
  if (recipient.status !== 'pending') {
    log(`recipient ${recipient.id} skipped: already ${recipient.status}`);
    await finalizeBroadcastIfDone(loaded.ctx.broadcast.id);
    return;
  }
  const attempts = recipient.attempts + 1;

  // Anti-ban: contato pediu pra não receber ("não perturbe") → não envia. Marca
  // como falha com motivo claro (aparece na aba de falhas com "opt-out").
  if (recipient.optedOut) {
    await markRecipientFailed(
      recipient.id,
      attempts,
      'Opt-out — contato pediu para não receber (não perturbe)',
    );
    log(`recipient ${recipient.id} skipped: opt-out`);
    await finalizeBroadcastIfDone(loaded.ctx.broadcast.id);
    return;
  }

  // Horário gravado manda (15/09, GoLink): ao retomar, os pendentes ganham
  // horários novos a partir de agora e os jobs são reagendados — mas um job
  // que estava travado na hora não dá pra reagendar e acordaria no ritmo
  // antigo, soltando envios juntos. Se o horário dele ainda não chegou, espera.
  const slotMs = recipient.slotAt ? Date.parse(recipient.slotAt) : NaN;
  if (Number.isFinite(slotMs) && slotMs - Date.now() > SLOT_EARLY_TOLERANCE_MS) {
    await job.moveToDelayed(slotMs, job.token);
    log(`recipient ${recipient.id} deferred to its slot ${recipient.slotAt}`);
    throw new DelayedError(); // moveToDelayed exige DelayedError (ver acima)
  }

  // Business-hours guard for humanized drips: if this job fires OUTSIDE the
  // allowed window/day (e.g. the worker was down across its slot and BullMQ
  // released it late), re-delay to the next valid window instead of sending
  // at, say, 3am. Slots are pre-computed inside the window, so in the happy
  // path this never triggers.
  if (loaded.ctx.broadcast.pacing) {
    const cfg = normalizePacing(loaded.ctx.broadcast.pacing as Partial<PacingConfig>);
    const nowMs = Date.now();
    const minute = localMinuteOfDay(nowMs, cfg.offsetMin);
    const weekday = localWeekday(nowMs, cfg.offsetMin);
    const within =
      cfg.days.includes(weekday) && minute >= cfg.startMin && minute < cfg.endMin;
    if (!within) {
      const next = computeDripSlots(1, cfg, nowMs)[0];
      if (next && next > nowMs) {
        await job.moveToDelayed(next, job.token);
        log(`recipient ${recipient.id} deferred to next business window`);
        throw new DelayedError(); // ver nota acima: moveToDelayed exige DelayedError
      }
    }
  }

  // Repetido na hora do envio (ver alreadyReceivedElsewhere): depois dos
  // adiamentos (o job pode dormir horas até o horário/expediente) e antes do
  // jitter, pra conferir o mais perto possível do envio.
  if (await alreadyReceivedElsewhere(loaded.ctx)) {
    await markRecipientFailed(recipient.id, attempts, ALREADY_RECEIVED_ELSEWHERE_ERROR);
    log(`recipient ${recipient.id} skipped: já recebeu por outro disparo nas últimas 24 h`);
    await finalizeBroadcastIfDone(loaded.ctx.broadcast.id);
    return;
  }

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
    vars: recipient.vars,
  });

  if (result.ok) {
    await markRecipientSent(recipient.id, result.externalMessageId, attempts);
    log(`sent recipient ${recipient.id} → ${result.externalMessageId}`);
    // 15/09 (GoLink): quem criou o disparo passa a ver a conversa gerada, mesmo
    // num número dedicado a outra pessoa (vira participante; responsável, setor
    // e número ficam como estão). Nunca lança — o envio já saiu.
    if (recipient.contactId) {
      await linkBroadcastConversation({
        accountId: loaded.ctx.broadcast.accountId,
        channelId: channel.id,
        contactId: recipient.contactId,
        creatorUserId: loaded.ctx.broadcast.userId,
        broadcastId: loaded.ctx.broadcast.id,
      });
    }
    await finalizeBroadcastIfDone(loaded.ctx.broadcast.id);
    return;
  }

  // Failure — classify.

  // CHANNEL in trouble (reputation 463 / session down)? Then this isn't about
  // this recipient: every remaining one would fail too, and with a 463 each
  // extra attempt burns the sender number further. Stop the WHOLE broadcast
  // (pause + alert the owner) instead of grinding through the rest. The pause
  // is race-safe, so only the first job to notice raises the alert; the other
  // queued recipients see 'paused' and defer, keeping their place for a later
  // "Reenviar falhados".
  const haltReason = channelHaltReason(result.error);
  if (haltReason) {
    await markRecipientFailed(recipient.id, attempts, result.error);
    const paused = await haltBroadcast(
      loaded.ctx.broadcast.id,
      haltReason,
      result.error,
    );
    log(
      `recipient ${recipient.id} channel-halt (${haltReason})` +
        `${paused ? ' → broadcast PAUSADO + alerta' : ''}: ${result.error}`,
    );
    await finalizeBroadcastIfDone(loaded.ctx.broadcast.id);
    throw new UnrecoverableError(result.error);
  }

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

  if (!(await markBroadcastSending(broadcastId))) {
    log(`dispatch ${broadcastId} skipped: broadcast no longer scheduled/sending`);
    return;
  }
  await ensureRecipientWorker(channel.id);

  // Each pending recipient carries a slot (humanized drip or a spaced
  // "send now"). Enqueue it with delay = slot - now; a null slot (plain
  // burst) means immediate. BullMQ then fires each at the right time and
  // the per-channel limiter caps the raw rate as a safety net.
  const slots = await listPendingRecipientSlots(broadcastId);
  const now = Date.now();
  log(
    `dispatch ${broadcastId}: scheduling ${slots.length} recipients on ` +
      `channel ${channel.id}`,
  );
  for (const { id, slotAt } of slots) {
    const delayMs = slotAt ? Math.max(0, Date.parse(slotAt) - now) : 0;
    await enqueueRecipient(channel.id, { broadcastId, recipientRowId: id }, { delayMs });
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

// Scheduled 1:1 messages ("Agendar mensagem") run in this same process on
// their own queue. Kept as a separate module for clarity; closed on shutdown.
const scheduledWorker = startScheduledMessageWorker();

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
    await scheduledWorker.close();
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
