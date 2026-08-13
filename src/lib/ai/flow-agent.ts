// ============================================================
// Flow "AI step" helper — generates one conversational AI reply for the
// flow engine's `ai` node, reusing the exact Agentes IA pipeline the
// auto-reply path uses (config → conversation context → RAG → prompt →
// generate). The flow node owns the buffering/looping/sending; this just
// produces the next reply text + the AI's handoff decision.
// ============================================================

import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { buildSystemPrompt } from './defaults'
import { generateReply } from './generate'
import { latestUserMessage } from './query'

export interface FlowAiReplyArgs {
  accountId: string
  conversationId: string
  /** Extra per-node instructions, layered on the account agent's prompt. */
  nodePrompt?: string
  /** Ground the answer in the account knowledge base (RAG). */
  useKnowledge: boolean
}

export interface FlowAiReplyResult {
  /** false when there's no usable AI config / nothing to answer / an error. */
  ok: boolean
  /** Reply text (empty on !ok or when the AI defers to a human). */
  text: string
  /** The AI signalled it can't/shouldn't answer — route to a human. */
  handoff: boolean
  /** Short machine-ish reason when ok === false. */
  reason?: string
}

/**
 * Extra directive appended to the system prompt for the flow AI node so
 * replies read like a human on WhatsApp: short, and broken into a few
 * separate messages (blank line between them) instead of one wall of
 * text. `splitIntoMessages` then turns those blocks into real messages.
 */
const HUMANIZE_DIRECTIVE =
  'Responda como um atendente humano no WhatsApp: mensagens curtas e ' +
  'diretas, no idioma do cliente. Quando precisar dizer mais de uma coisa, ' +
  'quebre em mensagens curtas separadas por uma LINHA EM BRANCO (parágrafos). ' +
  'Evite textões, listas longas e markdown.'

export async function generateFlowAiReply(
  args: FlowAiReplyArgs,
): Promise<FlowAiReplyResult> {
  try {
    // requireActive:false — the flow explicitly invoked the AI, so it runs
    // even when the account's agent isn't marked active for auto-reply; it
    // just needs a provider + key configured.
    const config = await loadAiConfig(args.accountId, { requireActive: false })
    if (!config) {
      return { ok: false, text: '', handoff: false, reason: 'no_ai_config' }
    }

    const messages = await buildConversationContext(args.conversationId)
    if (messages.length === 0) {
      return { ok: false, text: '', handoff: false, reason: 'no_messages' }
    }

    const knowledge = args.useKnowledge
      ? await retrieveKnowledge(
          args.accountId,
          config,
          latestUserMessage(messages),
          5,
          config.knowledgeBaseIds ?? [],
        )
      : []

    const combinedPrompt = [config.systemPrompt, args.nodePrompt, HUMANIZE_DIRECTIVE]
      .map((p) => (p ?? '').trim())
      .filter(Boolean)
      .join('\n\n')

    const systemPrompt = buildSystemPrompt({
      userPrompt: combinedPrompt || null,
      mode: 'auto_reply',
      knowledge,
    })

    const { text, handoff } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    return { ok: true, text: text ?? '', handoff }
  } catch (err) {
    return {
      ok: false,
      text: '',
      handoff: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Split an AI reply into a few short WhatsApp messages so it doesn't
 * arrive as one wall of text. Prefers blank-line paragraph breaks, falls
 * back to single newlines, and merges any overflow past `maxParts` into
 * the last message. Returns [] for empty input.
 */
export function splitIntoMessages(text: string, maxParts = 4): string[] {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return []

  let parts = trimmed
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean)

  if (parts.length < 2) {
    parts = trimmed
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }

  if (parts.length <= 1) return [trimmed]
  if (parts.length <= maxParts) return parts

  const head = parts.slice(0, maxParts - 1)
  const tail = parts.slice(maxParts - 1).join('\n\n')
  return [...head, tail]
}
