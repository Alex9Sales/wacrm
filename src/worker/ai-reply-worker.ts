// ============================================================
// AI auto-reply worker — the "message buffer".
//
// Inbound messages enqueue a DEBOUNCED job (jobId per conversation) that only
// fires after `AI_REPLY_BUFFER_SECONDS` of quiet. This worker processes that
// job: it calls the same `dispatchInboundToAiReply` the webhook used to call
// inline, but now once per burst instead of once per message.
//
// The eligibility gates (assigned agent, AI paused, per-conversation cap, no
// active flow/automation) live inside dispatch and are re-checked HERE, at fire
// time — so a human who takes over during the buffer window cancels the reply.
// ============================================================

import { Worker } from 'bullmq';

import { bullConnection } from '@/lib/queue/connection';
import { AI_REPLY_QUEUE, type AiReplyJob } from '@/lib/queue/queues';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';

function log(...args: unknown[]) {
  console.log('[ai-reply-worker]', ...args);
}

export function startAiReplyWorker(): Worker<AiReplyJob> {
  const worker = new Worker<AiReplyJob>(
    AI_REPLY_QUEUE,
    async (job) => {
      await dispatchInboundToAiReply(job.data);
    },
    { connection: bullConnection(), concurrency: 4 },
  );
  worker.on('failed', (job, err) =>
    log(`${job?.data.conversationId} failed:`, err?.message),
  );
  worker.on('error', (err) => log('worker error:', err.message));
  log(`listening on '${AI_REPLY_QUEUE}'.`);
  return worker;
}
