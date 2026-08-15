import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, automations, conversations, contacts } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadAiConfigForChannel } from './config'
import { hasActiveAutoReplyAgent } from './agents'
import { aiHoursAllows } from './hours-gate'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { getCompanyProfile, formatCompanyProfileForPrompt } from './company-profile'
import { formatCatalogForPrompt } from './catalog'
import { generateReply } from './generate'
import { buildSystemPrompt, parseCloseDirectives } from './defaults'
import { applyCloseActions, loadDealCloseContext } from './close-actions'
import { latestUserMessage } from './query'
import { randomUUID } from 'crypto'
import {
  engineSendText,
  engineSendTyping,
  engineSendMedia,
} from '@/lib/flows/meta-send'
import { splitIntoMessages } from '@/lib/ai/flow-agent'
import { AUDIO_MARKER, PHOTO_DIRECTIVE } from '@/lib/ai/defaults'
import { resolveProductPhoto } from '@/lib/ai/catalog'
import { synthesizeSpeech } from '@/lib/ai/tts'
import { putObject, publicUrl } from '@/lib/storage/s3'

const TTS_BUCKET = 'media'

/** Pausa "digitando…" antes de cada mensagem, escalada pelo tamanho. */
function humanTypingDelayMs(text: string): number {
  return Math.min(2500, Math.max(600, text.length * 35))
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    // Cheap early-out: no active auto-reply agent on this account → nothing to
    // do (avoids the conversation load + routing for non-AI accounts).
    if (!(await hasActiveAutoReplyAgent(accountId))) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const autoResponders = await db
      .select({ id: automations.id })
      .from(automations)
      .where(
        and(
          eq(automations.accountId, accountId),
          eq(automations.isActive, true),
          inArray(automations.triggerType, [
            'new_message_received',
            'keyword_match',
          ]),
        ),
      )
      .limit(1)
    if (autoResponders.length > 0) return

    const conv = firstOrNull(
      await db
        .select({
          assignedAgentId: conversations.assignedAgentId,
          aiAutoreplyDisabled: conversations.aiAutoreplyDisabled,
          aiReplyCount: conversations.aiReplyCount,
          channelId: conversations.channelId,
          isGroup: contacts.isGroup,
        })
        .from(conversations)
        .innerJoin(contacts, eq(conversations.contactId, contacts.id))
        .where(eq(conversations.id, conversationId))
        .limit(1),
    )
    if (!conv) return

    // Multi-agente: escolhe o agente atribuído ao CANAL desta conversa.
    // requireAutoReply → só um agente ativo e com auto-resposta ligada é
    // elegível; o roteamento por canal (incl. "lista vazia = todos os canais")
    // vive em pickAgentIdForChannel, então não há gate de canal separado aqui.
    const config = await loadAiConfigForChannel(accountId, conv.channelId, {
      requireAutoReply: true,
    })
    if (!config || !config.autoReplyEnabled) return

    // Horário de atendimento da IA: só responde conforme o modo
    // (sempre / só dentro / só fora do horário da conta). Fora da janela
    // permitida, fica muda (um humano cuida no horário certo).
    // Settings da conta: usado pro gate de horário E pro fuso injetado no prompt.
    const settings = await getAccountSettings(accountId)
    if (config.autoReplyHoursMode !== 'always') {
      if (!aiHoursAllows(config.autoReplyHoursMode, settings)) return
    }
    // NEVER auto-reply in a GROUP thread. The bot answering inside a WhatsApp
    // group is almost always wrong (it would reply to every member's message,
    // spamming the group) and risky for the number's reputation — so it's a
    // hard lock, not a per-account toggle. 1:1 threads are unaffected.
    if (conv.isGroup) return
    if (conv.assignedAgentId) return // a human owns this thread
    if (conv.aiAutoreplyDisabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.aiReplyCount >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(
      conversationId,
      undefined,
      settings.businessTimezone,
    )
    if (messages.length === 0) return

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      accountId,
      config,
      latestUserMessage(messages),
      5,
      config.knowledgeBaseIds ?? [],
    )
    const companyProfile = formatCompanyProfileForPrompt(
      await getCompanyProfile(accountId),
    )
    const catalog = await formatCatalogForPrompt(accountId)

    // Encerramento inteligente (opt-in): injeta as etapas do funil ligado pra a
    // IA poder escolher uma ao encerrar.
    const closeCtx = config.autoCloseEnabled
      ? await loadDealCloseContext(accountId, conversationId)
      : null

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      companyProfile,
      catalog,
      timezone: settings.businessTimezone,
      autoClose: config.autoCloseEnabled,
      pipelineStages: closeCtx?.stageNames ?? [],
    })

    const { text: rawText, handoff } = await generateReply({
      config,
      systemPrompt,
      messages,
      // Medidor de custo (Fase B): atribui o uso ao agente/canal/conversa.
      meta: {
        accountId,
        agentId: config.id ?? null,
        conversationId,
        channelId: conv.channelId,
        source: 'inbox',
      },
    })

    // Extrai os marcadores de encerramento ([[RESOLVER]]/[[FUNIL:..]]) do texto.
    const close = config.autoCloseEnabled ? parseCloseDirectives(rawText) : null
    const text = close ? close.text : rawText

    // Executa resolver + mover o funil (best-effort). Chamado após enviar (ou
    // direto quando o encerramento veio sem texto).
    const runClose = async () => {
      if (close && (close.resolve || close.funnelStage)) {
        const r = await applyCloseActions({
          accountId,
          userId: configOwnerUserId || null,
          conversationId,
          resolve: close.resolve,
          funnelStageName: close.funnelStage,
        })
        console.log('[ai auto-reply] encerramento:', JSON.stringify(r))
      }
    }

    if (handoff) {
      // Pediu humano — para de auto-responder aqui até um admin reativar.
      await db
        .update(conversations)
        .set({ aiAutoreplyDisabled: true })
        .where(eq(conversations.id, conversationId))
      return
    }
    if (!text) {
      // Sem texto: se foi só encerramento (marcadores sem despedida), executa e
      // sai; senão, desabilita a IA nesta conversa (nada útil pra responder).
      if (close && (close.resolve || close.funnelStage)) {
        await runClose()
        return
      }
      await db
        .update(conversations)
        .set({ aiAutoreplyDisabled: true })
        .where(eq(conversations.id, conversationId))
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const res = await db.execute(
      sql`SELECT claim_ai_reply_slot(${conversationId}, ${config.autoReplyMaxPerConversation}) AS claimed`,
    )
    const claimed = (res.rows[0] as { claimed?: boolean } | undefined)?.claimed
    if (claimed !== true) return

    // Responde como algumas mensagens curtas e humanas (quebra de linha),
    // mostrando "digitando…" e uma pausa antes de cada uma. A IA decide texto
    // vs ÁUDIO: uma mensagem que começa com AUDIO_MARKER vira nota de voz (TTS).
    // Chave do TTS: OpenAI (a de chat quando provider=openai, senão a de
    // embeddings). Sem chave OpenAI → o marcador é removido e vai como texto.
    const ttsKey =
      config.provider === 'openai'
        ? config.apiKey
        : config.embeddingsApiKey || null

    // Assinatura do atendente: quando ligada, a 1ª mensagem de TEXTO vai
    // prefixada com "*Nome:*\n…" — MESMO formato do atendente humano
    // (send/route.ts), na mesma bolha do texto. Áudio não leva assinatura.
    const signature =
      config.signatureEnabled && config.signatureName
        ? config.signatureName.trim()
        : null
    // O modelo às vezes IMITA a assinatura no começo da resposta (o histórico
    // tem msgs da IA já prefixadas), o que fazia o nome sair DOBRADO ou numa
    // bolha separada. Remove uma assinatura logo no início (com ou sem ":") e
    // a gente reaplica limpa junto da 1ª mensagem.
    const body = signature
      ? text.replace(
          new RegExp(
            `^\\s*\\*${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:?\\*\\s*\\n?`,
            'i',
          ),
          '',
        )
      : text
    let signed = false

    const parts = splitIntoMessages(body)
    for (const rawPart of parts) {
      // Foto de produto (agente de Vendas): uma parte que é só "[[foto:Nome]]"
      // vira ANEXO de imagem — resolve a URL da foto no catálogo e envia como
      // mídia. Item sem foto / não encontrado → ignora silenciosamente.
      const photoMatch = rawPart.trim().match(PHOTO_DIRECTIVE)
      if (photoMatch) {
        const photo = await resolveProductPhoto(accountId, photoMatch[1])
        if (photo) {
          try {
            await engineSendTyping({ accountId, conversationId, contactId, on: true })
            await sleep(600)
            await engineSendMedia({
              accountId,
              userId: configOwnerUserId,
              conversationId,
              contactId,
              kind: 'image',
              link: photo.url,
              caption: photo.name,
            })
          } catch (err) {
            console.error('[ai auto-reply] envio de foto do produto falhou:', err)
          }
        }
        continue
      }

      const wantsAudio = rawPart.trimStart().startsWith(AUDIO_MARKER)
      const clean = rawPart.replace(AUDIO_MARKER, '').trim()
      if (!clean) continue

      try {
        await engineSendTyping({ accountId, conversationId, contactId, on: true })
        await sleep(humanTypingDelayMs(clean))
      } catch {
        /* presença é best-effort — nunca bloqueia o envio */
      }

      if (wantsAudio && ttsKey) {
        try {
          const bytes = await synthesizeSpeech(ttsKey, clean)
          const key = `ai-audio/${randomUUID()}.ogg`
          await putObject(TTS_BUCKET, key, bytes, 'audio/ogg; codecs=opus')
          await engineSendMedia({
            accountId,
            userId: configOwnerUserId,
            conversationId,
            contactId,
            kind: 'audio',
            link: publicUrl(TTS_BUCKET, key),
            // O texto falado vira a transcrição do áudio no CRM (igual inbound).
            transcription: clean,
          })
          continue // enviou como áudio; não manda o texto também
        } catch (err) {
          console.error('[ai auto-reply] TTS falhou, enviando como texto:', err)
          // cai pro envio de texto abaixo
        }
      }

      // Assina só a 1ª mensagem, no formato do atendente ("*Nome:*\n…"), na
      // MESMA bolha do texto (a mimética já foi removida acima).
      const textToSend =
        signature && !signed ? `*${signature}:*\n${clean}` : clean
      signed = true
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text: textToSend,
      })
    }

    // Depois de enviar a despedida, executa o encerramento (resolver + mover).
    await runClose()
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
