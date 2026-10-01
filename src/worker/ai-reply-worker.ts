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
import { and, eq, gte, ne } from 'drizzle-orm';

import { db, messages } from '@/db';
import { publishEvent } from '@/lib/events/publish';
import { bullConnection } from '@/lib/queue/connection';
import { AI_REPLY_QUEUE, type AiReplyJob } from '@/lib/queue/queues';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';

function log(...args: unknown[]) {
  console.log('[ai-reply-worker]', ...args);
}

/**
 * A rodada da IA gravou alguma coisa nesta conversa? Então avisa a tela.
 *
 * As mensagens que saem para o cliente já avisam sozinhas (engineSend*), mas a
 * IA também grava NOTAS internas — transferência, encerramento, promessa de
 * pagamento, "confirmou sem ter feito" — e várias nascem depois do último
 * envio. Sem este aviso, a nota só aparecia na tela com F5 (01/10).
 *
 * Só avisa se houve escrita: a maioria das rodadas termina calada (IA
 * pausada, humano no atendimento) e não precisa fazer a tela recarregar.
 */
async function avisarSeGravou(job: AiReplyJob, desde: Date): Promise<void> {
  try {
    const gravou = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, job.conversationId),
          ne(messages.senderType, 'customer'),
          gte(messages.createdAt, desde.toISOString()),
        ),
      )
      .limit(1);
    if (gravou.length === 0) return;
    await publishEvent(job.accountId, {
      type: 'message.received',
      conversationId: job.conversationId,
      fromMe: true,
    });
  } catch (err) {
    log(`${job.conversationId} aviso de fim de rodada falhou:`, err instanceof Error ? err.message : err);
  }
}

export function startAiReplyWorker(): Worker<AiReplyJob> {
  const worker = new Worker<AiReplyJob>(
    AI_REPLY_QUEUE,
    async (job) => {
      const desde = new Date(Date.now() - 1_000);
      try {
        await dispatchInboundToAiReply(job.data);
      } finally {
        await avisarSeGravou(job.data, desde);
      }
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
