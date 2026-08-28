import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, automations, conversations, contacts, messages as messagesTable, aiConfigs } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadAiConfigForChannel, loadAiConfigById } from './config'
import { hasActiveAutoReplyAgent } from './agents'
import { aiHoursAllows } from './hours-gate'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { buildCustomerFactsBlock } from '@/lib/cdl/metrics'
import {
  buildConversationContext,
  loadContactHistoryDigest,
  stripLeadingTimestamp,
} from './context'
import { retrieveKnowledge } from './knowledge'
import { getCompanyProfile, formatCompanyProfileForPrompt } from './company-profile'
import { formatCatalogForPrompt } from './catalog'
import { generateWithExternalTools } from './external-tools'
import { buildSystemPrompt, parseCloseDirectives } from './defaults'
import {
  applyCloseActions,
  loadDealCloseContext,
  listAccountTagNames,
  applyTagsByName,
  createDealFromAi,
  postInternalNote,
  setContactAttribute,
  listContactFieldNames,
  setVoicePreference,
} from './close-actions'
import { scheduleEventFromAi } from './schedule-actions'
import { listRoutingTags, applyTransfer } from './transfer-actions'
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
import { planStageFollowUp } from '@/lib/ai/followup'
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
  /** 🔀 Interno: nº de transferências entre agentes já feitas NESTE inbound
   *  (guarda anti ping-pong — máx. 1). Nunca passar de fora. */
  routeHop?: number
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
          aiAgentId: conversations.aiAgentId,
          aiReplyCount: conversations.aiReplyCount,
          channelId: conversations.channelId,
          voicePreference: conversations.voicePreference,
          humanPresentUntil: conversations.humanPresentUntil,
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
    // 🔀 Agente DONO da conversa (roteamento multiagente): se um agente já
    // assumiu esta conversa, é ele quem responde — senão resolve pelo canal.
    // Dono inválido (apagado/desativado/sem auto-resposta) → fallback canal.
    let config =
      conv.aiAgentId != null
        ? await loadAiConfigById(accountId, conv.aiAgentId)
        : null
    if (config && !config.autoReplyEnabled) config = null
    if (!config) {
      config = await loadAiConfigForChannel(accountId, conv.channelId, {
        requireAutoReply: true,
      })
    }
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
    // 👤 Humano DIGITANDO: o atendente começou a responder no inbox (marca
    // renovada a cada digitada). A IA recua na hora, antes mesmo dele enviar —
    // não atropela quem está compondo. Volta sozinha quando ele para de digitar.
    if (
      conv.humanPresentUntil &&
      new Date(conv.humanPresentUntil).getTime() > Date.now()
    )
      return
    // 🤫 Barge-in: um HUMANO respondeu há pouco nesta conversa (pelo CRM ou
    // pelo celular — fromMe vira sender_type 'agent')? A IA fica quieta pela
    // janela configurada, SEM desligar — o humano está conduzindo. Depois da
    // janela ela volta observando (o prompt instrui a não atropelar).
    const bargeInMin = config.bargeInMinutes ?? 5
    if (bargeInMin > 0) {
      const recentHuman = firstOrNull(
        await db
          .select({ id: messagesTable.id })
          .from(messagesTable)
          .where(
            and(
              eq(messagesTable.conversationId, conversationId),
              eq(messagesTable.senderType, 'agent'),
              sql`${messagesTable.createdAt} > now() - make_interval(mins => ${bargeInMin})`,
            ),
          )
          .limit(1),
      )
      if (recentHuman) return
    }
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

    // Ferramentas ligadas neste agente (Fase A).
    const tools = config.tools ?? []
    const has = (k: string) => tools.includes(k)

    // move_card: injeta as etapas do funil ligado pra a IA escolher uma.
    const closeCtx = has('move_card')
      ? await loadDealCloseContext(accountId, conversationId)
      : null
    // tag: etiquetas existentes da conta (pra IA qualificar).
    const accountTags = has('tag') ? await listAccountTagNames(accountId) : []
    // handoff: etiquetas de roteamento (atendentes etiquetados) pra transferir.
    const routingTags = has('handoff') ? await listRoutingTags(accountId) : []
    // 🔀 route_agent: os OUTROS agentes ativos da conta (candidatos a receber
    // a conversa). Sem outros agentes → a ferramenta fica inerte.
    const agentRoster = has('route_agent')
      ? (
          await db
            .select({ id: aiConfigs.id, name: aiConfigs.name })
            .from(aiConfigs)
            .where(
              and(
                eq(aiConfigs.accountId, accountId),
                eq(aiConfigs.isActive, true),
                eq(aiConfigs.autoReplyEnabled, true),
              ),
            )
        ).filter((a) => a.id !== config!.id)
      : []
    // set_attribute: nomes dos campos personalizados do contato.
    const customFieldNames = has('set_attribute')
      ? await listContactFieldNames(accountId)
      : []

    // Dados do CONTATO no prompt: sem o telefone a IA não consegue chamar
    // ferramentas externas que buscam o cliente por telefone (caso Maria 26/08
    // — ela pedia o CPF em vez de consultar o cadastro sozinha).
    const contactRow = firstOrNull(
      await db
        .select({ name: contacts.name, phone: contacts.phone })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .limit(1),
    )

    // 🔁 "Não perde venda": o MESMO contato pode ter falado em OUTRO número de
    // WhatsApp da loja. Puxa o que ele disse nas outras conversas pra a IA dar
    // continuidade (ex.: recuou do preço num número → reconhece no outro e já
    // oferece o desconto). Best-effort.
    const priorContactContext = await loadContactHistoryDigest(
      accountId,
      contactId,
      conversationId,
      settings.businessTimezone,
    )

    // 📊 CUSTOMER FACTS (CDL Fase 4): memória comercial NATIVA do cliente
    // (histórico + métricas). Determinístico. Best-effort — null se sem histórico.
    const customerFacts = await buildCustomerFactsBlock(
      accountId,
      contactId,
      settings.businessTimezone,
    ).catch(() => null)

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      companyProfile,
      catalog,
      timezone: settings.businessTimezone,
      tools,
      pipelineStages: closeCtx?.stageNames ?? [],
      availableTags: accountTags,
      routingTags,
      customFieldNames,
      voicePref: conv.voicePreference,
      audioReplies: config.audioRepliesEnabled !== false,
      agentRoster: agentRoster.map((a) => ({ name: a.name ?? 'Agente' })),
      contact: contactRow
        ? { name: contactRow.name, phone: contactRow.phone }
        : null,
      priorContactContext,
      customerFacts,
    })

    // 🔧 Com ferramentas externas do agente (ERP do cliente etc.) — sem
    // ferramentas, degrada pro generateReply puro.
    const { text: rawText, handoff, orderForCard } = await generateWithExternalTools({
      config,
      systemPrompt,
      messages,
      accountId,
      agentId: config.id ?? null,
      conversationId,
      // Medidor de custo (Fase B): atribui o uso ao agente/canal/conversa.
      meta: {
        accountId,
        agentId: config.id ?? null,
        conversationId,
        channelId: conv.channelId,
        source: 'inbox',
      },
    })

    // Extrai TODOS os marcadores de ação do texto (skip/etiqueta/resolver/funil).
    const dirs = parseCloseDirectives(rawText)
    const text = dirs.text

    // Ações "leves" da conversa: etiquetar, nota interna, atributo, voz.
    const applyTags = async () => {
      if (has('tag') && dirs.tags.length) {
        const applied = await applyTagsByName({
          accountId,
          contactId,
          tagNames: dirs.tags,
        })
        if (applied.length) {
          console.log('[ai auto-reply] etiquetas:', applied.join(', '))
        }
      }
      if (has('private_note') && dirs.note) {
        await postInternalNote({ conversationId, text: dirs.note })
      }
      if (has('set_attribute') && dirs.attribute) {
        await setContactAttribute({
          accountId,
          contactId,
          field: dirs.attribute.field,
          value: dirs.attribute.value,
        })
      }
      if (has('voice_pref') && dirs.voicePref) {
        await setVoicePreference({
          accountId,
          conversationId,
          pref: dirs.voicePref,
        })
      }
      // 📣 Avisar o dono no WhatsApp (ex.: SDR marcou teste/demo). NÃO é travado
      // por ferramenta — best-effort, gated pelo telefone + toggle 'demo' da conta.
      if (dirs.ownerAlert) {
        try {
          const { sendOwnerAlert } = await import('@/lib/alerts/owner-alerts')
          const c = firstOrNull(
            await db
              .select({
                name: contacts.name,
                phone: contacts.phone,
                company: contacts.company,
              })
              .from(contacts)
              .where(eq(contacts.id, contactId))
              .limit(1),
          )
          await sendOwnerAlert(accountId, 'demo', {
            cliente: c?.name ?? '',
            telefone: c?.phone ?? '',
            empresa: c?.company ?? c?.name ?? '',
            resumo: dirs.ownerAlert.message,
          })
        } catch (err) {
          console.error('[ai auto-reply] aviso ao dono falhou:', err)
        }
      }
    }
    // Agendar (ferramenta 'schedule').
    const runSchedule = async () => {
      if (has('schedule') && dirs.schedule) {
        const ev = await scheduleEventFromAi({
          accountId,
          userId: configOwnerUserId || null,
          conversationId,
          contactId,
          startsLocal: dirs.schedule.startsLocal,
          title: dirs.schedule.title || 'Reunião',
          timezone: settings.businessTimezone,
        })
        if (ev) console.log('[ai auto-reply] agendou:', JSON.stringify(ev))
      }
    }
    // Cria o card no funil + dispara o aviso do responsável. createDealFromAi
    // dedupe por conversa, então chamar 2x (marcador + fallback) NÃO duplica —
    // a 2ª chamada volta null e não alerta de novo.
    const createDealAndAlert = async (card: {
      title: string
      value: number | null
      note: string | null
    }) => {
      const d = await createDealFromAi({
        accountId,
        userId: configOwnerUserId || null,
        conversationId,
        contactId,
        title: card.title,
        value: card.value,
        note: card.note,
        pipelineId: config.pipelineId ?? null,
      })
      if (!d) return
      console.log('[ai auto-reply] card criado:', JSON.stringify(d))
      // 📣 Aviso do responsável: pedido confirmado pela IA ("manda no grupo do
      // despacho"). Best-effort — o toggle/telefone é checado lá dentro.
      try {
        const { sendOwnerAlert } = await import('@/lib/alerts/owner-alerts')
        const c = firstOrNull(
          await db
            .select({ name: contacts.name, phone: contacts.phone })
            .from(contacts)
            .where(eq(contacts.id, contactId))
            .limit(1),
        )
        await sendOwnerAlert(accountId, 'order', {
          titulo: card.title,
          valor:
            card.value != null
              ? `R$ ${card.value.toFixed(2).replace('.', ',')}`
              : '',
          resumo: card.note ?? '',
          cliente: c?.name ?? '',
          telefone: c?.phone ?? '',
        })
      } catch (err) {
        console.error('[ai auto-reply] aviso de pedido falhou:', err)
      }
    }
    // Criar card no funil: (1) marcador [[CRIARCARD]] do modelo (título bonito);
    // (2) FALLBACK — uma ferramenta createsDeal (ex.: criar_pedido) rodou com
    // sucesso e o modelo NÃO emitiu o marcador → cria mesmo assim (não depende
    // do modelo lembrar). O fallback NÃO é travado por 'create_card'.
    const runCreateCard = async () => {
      if (has('create_card') && dirs.createCard) {
        await createDealAndAlert(dirs.createCard)
      }
      if (orderForCard) {
        await createDealAndAlert(orderForCard)
      }
    }
    // Transferir pra humano por etiqueta (ferramenta 'handoff' + [[TRANSFERIR]]).
    const runTransfer = async (): Promise<boolean> => {
      if (has('handoff') && dirs.transfer) {
        const r = await applyTransfer({
          accountId,
          conversationId,
          contactId,
          tagName: dirs.transfer.tag,
          summary: dirs.transfer.summary || null,
        })
        console.log('[ai auto-reply] transferência:', JSON.stringify(r))
        return true
      }
      return false
    }
    // Encerrar (ferramentas 'resolve' / 'move_card', gate individual).
    const runClose = async () => {
      const wantResolve = has('resolve') && dirs.resolve
      const wantMove = has('move_card') && dirs.funnelStage
      // Perder EM PÉ compartilha o gate de mutação do card ('move_card').
      const wantLose = has('move_card') && dirs.lose
      if (wantResolve || wantMove || wantLose) {
        const r = await applyCloseActions({
          accountId,
          userId: configOwnerUserId || null,
          conversationId,
          resolve: wantResolve,
          funnelStageName: wantMove ? dirs.funnelStage : null,
          loseReason: wantLose ? dirs.lose!.reason : null,
        })
        console.log('[ai auto-reply] encerramento:', JSON.stringify(r))
        // Se a IA moveu o card, recalcula o "próximo follow-up" pela nova etapa
        // na hora (mesmo comportamento do move manual).
        if (r.movedTo) {
          await planStageFollowUp({ accountId, conversationId, stageName: r.movedTo })
        }
      }
    }

    // 🔀 Transferência entre agentes ([[AGENTE:nome|resumo]]): muda o dono da
    // conversa e RE-DESPACHA — o especialista responde na hora, no mesmo
    // número, com o histórico inteiro. Máx. 1 salto por inbound (anti
    // ping-pong). Nome não resolvido → ignora em silêncio (nunca desliga a IA
    // por causa de um nome inventado).
    if (dirs.routeAgent && (args.routeHop ?? 0) === 0) {
      const norm = (v: string) =>
        v
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .trim()
      const want = norm(dirs.routeAgent.name)
      const candidates = agentRoster.length
        ? agentRoster
        : (
            await db
              .select({ id: aiConfigs.id, name: aiConfigs.name })
              .from(aiConfigs)
              .where(
                and(
                  eq(aiConfigs.accountId, accountId),
                  eq(aiConfigs.isActive, true),
                  eq(aiConfigs.autoReplyEnabled, true),
                ),
              )
          ).filter((a) => a.id !== config!.id)
      const target =
        candidates.find((a) => norm(a.name ?? '') === want) ??
        candidates.find(
          (a) => norm(a.name ?? '').includes(want) || want.includes(norm(a.name ?? '')),
        )
      if (target) {
        await db
          .update(conversations)
          .set({ aiAgentId: target.id })
          .where(eq(conversations.id, conversationId))
        await postInternalNote({
          conversationId,
          text: `🔀 IA: ${config.name ?? 'agente'} → ${target.name ?? 'agente'}${
            dirs.routeAgent.summary ? ` — ${dirs.routeAgent.summary}` : ''
          }`,
        })
        await applyTags()
        // O especialista gera e envia a resposta agora (mesmo inbound).
        await dispatchInboundToAiReply({ ...args, routeHop: 1 })
        return
      }
      console.warn(
        '[ai auto-reply] transferência ignorada — agente não encontrado:',
        dirs.routeAgent.name,
      )
      if (!text) return // só o marcador inválido: silêncio, sem desligar
    }
    // Hop 1 tentando transferir DE NOVO (ping-pong): ignora o marcador; se
    // não sobrou texto, silêncio — nunca desliga a IA por causa disso.
    if (dirs.routeAgent && (args.routeHop ?? 0) > 0 && !text) {
      console.warn('[ai auto-reply] transferência em cadeia bloqueada (hop>0)')
      return
    }

    // skip_reply: a msg não pedia resposta — NÃO responde, mas mantém a IA
    // ativa (não desabilita, não consome slot). Ainda pode etiquetar.
    if (has('skip_reply') && dirs.skipReply) {
      await applyTags()
      return
    }
    // Handoff (sentinel "pediu humano"): desliga a IA na conversa + avisa o
    // responsável. NÃO retorna antes do envio — o bug da 1ª transferência da
    // Maria (26/08): o modelo escreveu a despedida ("o responsável já vai te
    // chamar") e o código descartava o texto, deixando o cliente no vácuo.
    const finishHandoff = async () => {
      await db
        .update(conversations)
        .set({ aiAutoreplyDisabled: true })
        .where(eq(conversations.id, conversationId))
      try {
        const { sendOwnerAlert } = await import('@/lib/alerts/owner-alerts')
        const c = firstOrNull(
          await db
            .select({ name: contacts.name, phone: contacts.phone })
            .from(contacts)
            .where(eq(contacts.id, contactId))
            .limit(1),
        )
        // Resumo automático: últimas falas do CLIENTE (o modelo raramente manda
        // resumo no handoff, e o dono precisa de contexto no aviso — Alex 26/08).
        const clientTail = messages
          .filter((m) => m.role === 'user')
          .slice(-4)
          .map((m) => stripLeadingTimestamp(String(m.content)).slice(0, 90))
          .filter(Boolean)
          .join(' · ')
          .slice(0, 380)
        await sendOwnerAlert(accountId, 'handoff', {
          cliente: c?.name ?? '',
          telefone: c?.phone ?? '',
          motivo: 'A IA pediu um humano nesta conversa',
          resumo: clientTail ? `Cliente disse: ${clientTail}` : text || '',
        })
      } catch (err) {
        console.error('[ai auto-reply] aviso de handoff falhou:', err)
      }
    }
    if (handoff && !text) {
      // Sem despedida do modelo: manda uma curta padrão pra não sumir do nada.
      try {
        await engineSendText({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          text: 'Perfeito! Já estou te passando para um responsável — ele continua o atendimento daqui. 🙏',
        })
      } catch (err) {
        console.error('[ai auto-reply] despedida do handoff falhou:', err)
      }
      await applyTags()
      await finishHandoff()
      return
    }
    if (!text) {
      // Sem texto: se foi transferência/encerramento (marcadores sem despedida),
      // executa e sai; senão, desabilita a IA (nada útil pra responder).
      if (has('handoff') && dirs.transfer) {
        await applyTags()
        await runTransfer()
        return
      }
      if (
        (has('resolve') && dirs.resolve) ||
        (has('move_card') && (dirs.funnelStage || dirs.lose))
      ) {
        await runClose()
        await applyTags()
        return
      }
      await applyTags()
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
    const bodyNoSig = signature
      ? text.replace(
          new RegExp(
            `^\\s*\\*${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:?\\*\\s*\\n?`,
            'i',
          ),
          '',
        )
      : text
    // O modelo às vezes copia o carimbo "[DD/MM HH:mm]" do histórico pro começo
    // da resposta (era só metadata pra ele). Remove pra não vazar pro cliente.
    const body = stripLeadingTimestamp(bodyNoSig)
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
      const clean = stripLeadingTimestamp(
        rawPart.replace(AUDIO_MARKER, ''),
      ).trim()
      if (!clean) continue

      try {
        await engineSendTyping({ accountId, conversationId, contactId, on: true })
        await sleep(humanTypingDelayMs(clean))
      } catch {
        /* presença é best-effort — nunca bloqueia o envio */
      }

      // 👤 Re-checagem: o atendente começou a digitar ENQUANTO a IA compunha?
      // Aborta o envio na hora — ele assumiu a conversa. (Pega o caso que o
      // gate inicial não pega: presença marcada durante o delay de digitação.)
      const stillClear = firstOrNull(
        await db
          .select({ h: conversations.humanPresentUntil })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .limit(1),
      )
      if (stillClear?.h && new Date(stillClear.h).getTime() > Date.now()) return

      if (wantsAudio && ttsKey && config.audioRepliesEnabled !== false) {
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

    // Depois de enviar: etiqueta, cria card, agenda, transfere OU encerra
    // (transfer tem prioridade — se transferiu, não resolve/move).
    await applyTags()
    await runCreateCard()
    // Handoff COM texto: a despedida já foi enviada acima — agora desliga a IA
    // e avisa o responsável. Sem agendar/mover depois de pedir humano.
    if (handoff) {
      await finishHandoff()
      return
    }
    await runSchedule()
    const transferred = await runTransfer()
    if (!transferred) await runClose()
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
