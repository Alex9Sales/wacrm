// ============================================================
// IA no Segundo Zero — a primeira mensagem de WhatsApp pro lead que acabou de
// enviar um formulário de captação. Gerada pela IA do canal (persona do agente
// + perfil da empresa + o que o lead escreveu); se a IA não estiver disponível,
// cai num template caloroso. Enviada FORA do request de submit (after()), pra
// resposta do form continuar instantânea. Quando o lead responder, o agente do
// canal continua a conversa (mesmo mecanismo do inbox).
// Sem 'use server' e sem 'server-only' (rota pública + reuso futuro no worker).
// ============================================================

import { eq } from 'drizzle-orm'

import { db, conversations } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { loadAiConfigForChannel } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { getCompanyProfile } from '@/lib/ai/company-profile'

export interface CaptureIntroInput {
  accountId: string
  formName: string
  /** Canal preferido (intro_channel_id). null = canal padrão da conta. */
  channelId: string | null
  phone: string
  name: string | null
  company: string | null
  email: string | null
  /** O que o lead escreveu no campo "mensagem" (a matéria-prima da IA). */
  message: string | null
}

/** Primeiro nome, capitalizado de leve ("joão silva" → "João"). */
function firstName(name: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? ''
  if (!first) return ''
  return first.charAt(0).toUpperCase() + first.slice(1)
}

/** Template de fallback (sem IA): caloroso, cita a mensagem se houver. */
function fallbackIntro(input: CaptureIntroInput): string {
  const nome = firstName(input.name)
  const oi = nome ? `Oi, ${nome}! 👋` : 'Oi! 👋'
  const msg = (input.message ?? '').trim()
  if (msg) {
    return `${oi} Recebemos seu contato agorinha e já vi o que você escreveu. Pode deixar que vamos te ajudar com isso — me conta só mais um detalhe: qual a melhor forma de começarmos?`
  }
  return `${oi} Recebemos seu contato agorinha e já estamos por aqui. Como podemos te ajudar?`
}

/** Remove marcadores internos ([[RESOLVER]] etc.) e apara o tamanho. */
function sanitize(text: string): string {
  return text
    .replace(/\[\[[^\]]*\]\]/g, '')
    .trim()
    .slice(0, 800)
}

/** Gera o texto da primeira mensagem (IA do canal → fallback template). */
async function buildIntroText(
  input: CaptureIntroInput,
  channelId: string | null,
): Promise<string> {
  try {
    const config = await loadAiConfigForChannel(input.accountId, channelId, {
      requireActive: true,
      fallbackDefault: true,
    })
    if (!config) return fallbackIntro(input)

    const profile = await getCompanyProfile(input.accountId)
    const empresa = profile.trade_name || profile.business_name || ''
    const persona = (config.systemPrompt ?? '').trim()

    const task = [
      empresa
        ? `Você é o atendente de WhatsApp da empresa ${empresa}.`
        : 'Você é o atendente de WhatsApp da empresa.',
      profile.description ? `Sobre a empresa: ${profile.description}` : '',
      '',
      `Um lead ACABOU de preencher o formulário "${input.formName}" no site, segundos atrás. Escreva a PRIMEIRA mensagem de WhatsApp pra ele.`,
      'REGRAS:',
      '- Português do Brasil, tom caloroso e natural de WhatsApp (nada robótico).',
      '- 2 a 4 frases CURTAS. No máximo 1 emoji.',
      '- Cumprimente pelo primeiro nome.',
      '- Se ele escreveu uma mensagem/pedido, mostre que você LEU e responda a isso.',
      '- Termine com UMA pergunta que puxe a conversa.',
      '- Sem links, sem assinatura, sem dizer que é IA ou automático.',
      'Responda APENAS com o texto da mensagem.',
    ]
      .filter(Boolean)
      .join('\n')

    const systemPrompt = persona ? `${persona}\n\n${task}` : task

    const dados = [
      `Nome: ${input.name || '(não informou)'}`,
      input.company ? `Empresa: ${input.company}` : '',
      input.email ? `E-mail: ${input.email}` : '',
      `Mensagem do lead: ${(input.message ?? '').trim() || '(não escreveu mensagem)'}`,
    ]
      .filter(Boolean)
      .join('\n')

    const result = await generateReply({
      config,
      systemPrompt,
      messages: [{ role: 'user', content: `Dados do formulário:\n${dados}` }],
      meta: {
        accountId: input.accountId,
        agentId: config.id ?? null,
        channelId,
        source: 'capture',
      },
    })
    const text = sanitize(result.text)
    return text || fallbackIntro(input)
  } catch (err) {
    console.error('[capture ai-intro] geração falhou, usando template:', err)
    return fallbackIntro(input)
  }
}

/**
 * Envia a primeira mensagem pro lead (best-effort; nunca lança). Resolve a
 * conversa (cria se preciso — reusa o caminho do inbox, então a resposta do
 * lead cai no mesmo thread e o agente do canal assume), descobre o canal REAL,
 * gera o texto e envia.
 */
export async function sendCaptureAiIntro(input: CaptureIntroInput): Promise<void> {
  try {
    const resolved = await resolveConversationByPhone(
      input.accountId,
      input.phone,
      input.name,
      input.channelId,
    )
    // Canal REAL da conversa (o resolve pode ter caído no canal padrão).
    const conv = firstOrNull(
      await db
        .select({ channelId: conversations.channelId })
        .from(conversations)
        .where(eq(conversations.id, resolved.conversationId))
        .limit(1),
    )
    const channelId = conv?.channelId ?? input.channelId ?? null

    const text = await buildIntroText(input, channelId)
    await sendMessageToConversation(input.accountId, {
      conversationId: resolved.conversationId,
      messageType: 'text',
      contentText: text,
    })
    console.log(
      `[capture ai-intro] primeira mensagem enviada (conta ${input.accountId}, form "${input.formName}")`,
    )
  } catch (err) {
    console.error('[capture ai-intro] envio falhou:', err)
  }
}
