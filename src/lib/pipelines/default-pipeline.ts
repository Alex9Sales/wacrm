// ============================================================
// 🔀 Qual funil o negócio deve nascer.
//
// Alex, 22/09 (caso Dentai): a conta tem um WhatsApp por operação — Vendas da
// Sara, Suporte da Vitória — e TUDO nascia no "Funil de vendas", porque quem
// nasce sozinho não tem ninguém para escolher. Os funis das meninas ficaram
// desde 27/08 com zero negócios.
//
// Regra (a primeira que existir vence):
//   1. o que a chamada pediu explicitamente;
//   2. o funil do AGENTE de IA (ai_configs.pipeline_id) — já existia;
//   3. o funil do CANAL (channels.default_pipeline_id, migr 0187);
//   4. o funil mais antigo da conta — o que sempre foi feito.
//
// Sempre confere se o funil é DA conta: id de outra conta (payload de
// integração, canal movido) nunca pode virar card no funil de terceiros.
// Sem 'server-only' — o worker e o ingest de leads chamam isto.
// ============================================================

import { and, asc, eq } from 'drizzle-orm'

import { channels, conversations, db, pipelines } from '@/db'
import { firstOrNull } from '@/db/helpers'

/**
 * A decisão em si, sem banco: o primeiro funil VÁLIDO da lista vence. Cada
 * candidato já vem conferido contra a conta (ou null). Pura para ter teste —
 * é esta ordem que decide onde o negócio nasce.
 */
export function pickPipeline(candidatos: readonly (string | null | undefined)[]): string | null {
  for (const c of candidatos) {
    const id = (c ?? '').trim()
    if (id) return id
  }
  return null
}

/** O funil pertence a esta conta? Null quando não existe (ou é de outra). */
async function pipelineOfAccount(accountId: string, pipelineId: string | null | undefined): Promise<string | null> {
  if (!pipelineId) return null
  const row = firstOrNull(
    await db
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(and(eq(pipelines.id, pipelineId), eq(pipelines.accountId, accountId)))
      .limit(1),
  )
  return row?.id ?? null
}

/** Funil padrão configurado no canal (null = não configurado). */
export async function pipelineOfChannel(accountId: string, channelId: string | null | undefined): Promise<string | null> {
  if (!channelId) return null
  const row = firstOrNull(
    await db
      .select({ pipelineId: channels.defaultPipelineId })
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.accountId, accountId)))
      .limit(1),
  )
  return pipelineOfAccount(accountId, row?.pipelineId ?? null)
}

/** Funil do canal DA CONVERSA — o caminho mais comum (card nasce pelo chat). */
export async function pipelineOfConversation(
  accountId: string,
  conversationId: string | null | undefined,
): Promise<string | null> {
  if (!conversationId) return null
  const row = firstOrNull(
    await db
      .select({ channelId: conversations.channelId })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)))
      .limit(1),
  )
  return pipelineOfChannel(accountId, row?.channelId ?? null)
}

/** O funil mais antigo da conta — último recurso, como sempre foi. */
export async function oldestPipeline(accountId: string): Promise<string | null> {
  const row = firstOrNull(
    await db
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(eq(pipelines.accountId, accountId))
      .orderBy(asc(pipelines.createdAt))
      .limit(1),
  )
  return row?.id ?? null
}

/**
 * Resolve o funil na ordem acima. `preferred` costuma ser o funil do agente de
 * IA ou o pedido pela integração. Nunca lança: na dúvida devolve o da conta.
 */
export async function resolveTargetPipeline(input: {
  accountId: string
  preferred?: string | null
  conversationId?: string | null
  channelId?: string | null
}): Promise<string | null> {
  const { accountId } = input
  try {
    const pedido = await pipelineOfAccount(accountId, input.preferred)
    const doCanal = pedido
      ? null
      : input.channelId
        ? await pipelineOfChannel(accountId, input.channelId)
        : await pipelineOfConversation(accountId, input.conversationId)
    const escolhido = pickPipeline([pedido, doCanal])
    if (escolhido) return escolhido
  } catch (err) {
    console.error('[funil padrão] falhou, seguindo com o funil da conta:', err instanceof Error ? err.message : err)
  }
  return oldestPipeline(accountId)
}
