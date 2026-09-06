// ============================================================
// 🧾 Comando do dono pelo WhatsApp (item 6 da auditoria de 05/09).
//
// O DONO da conta manda, do WhatsApp dele, para o número da empresa:
// "cria uma cobrança de 150 pro João vencendo dia 10". Fluxo:
//   1. só o telefone do dono (Avisos / Sócio IA em Configurações) aciona isto;
//   2. o modelo extrai cliente/valor/vencimento/descrição → normalizado pelas
//      MESMAS regras da emissão (owner-command-rules);
//   3. cliente ambíguo → lista numerada; sem achar → pede o telefone;
//   4. PROPOSTA → "Responda SIM" → só então cria no Asaas e manda o link ao
//      cliente pelo canal configurado (mesma tubulação da "Nova cobrança");
//   5. resposta ao dono com o link. Estado de 15 min no Redis; nunca lança.
// Sem 'server-only' — roda no worker.
// ============================================================

import { and, desc, eq } from 'drizzle-orm'

import { db, aiConfigs, conversations } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadAiConfigById } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { kvDel, kvGetJson, kvSetJson } from '@/lib/ai/reply-marker'
import { findContactsByQuery, type FoundContact } from '@/lib/contacts/search'
import { engineSendText } from '@/lib/flows/meta-send'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { phonesMatch } from '@/lib/whatsapp/phone-utils'

import { createChargeForContact } from './emit'
import { manualChargeMessage } from './emit-rules'
import {
  formatCandidates,
  formatDone,
  formatProposal,
  looksLikeCancel,
  looksLikeChargeCommand,
  looksLikeConfirmation,
  normalizeParsedCommand,
  pickCandidateIndex,
  type RawParsedCommand,
} from './owner-command-rules'
import { resolveCollectionTargets } from './outreach'

const TTL_SECONDS = 15 * 60
const key = (conversationId: string) => `owner:charge:${conversationId}`

interface Proposal {
  contactId: string
  name: string | null
  phone: string
  value: number
  dueDate: string
  description: string
}

interface Pending {
  stage: 'choose' | 'confirm'
  candidates?: FoundContact[]
  draft?: { value: number; dueDate: string; description: string }
  proposal?: Proposal
}

/** O telefone de quem escreveu é o do dono (Avisos ou Sócio IA)? */
export function isOwnerPhone(settings: { alertPhone?: string; ownerDigestPhone?: string }, phone: string | null | undefined): boolean {
  const p = (phone ?? '').replace(/\D/g, '')
  if (!p) return false
  for (const candidate of [settings.alertPhone, settings.ownerDigestPhone]) {
    const c = (candidate ?? '').replace(/\D/g, '')
    if (c && phonesMatch(c, p)) return true
  }
  return false
}

/** Vale a pena olhar? (tem proposta pendente, ou o texto parece pedido). Barato — sem LLM. */
export async function ownerCommandApplies(conversationId: string, text: string): Promise<boolean> {
  if (looksLikeChargeCommand(text)) return true
  const pending = await kvGetJson<Pending>(key(conversationId))
  return !!pending
}

async function extractWithModel(accountId: string, text: string): Promise<RawParsedCommand | null> {
  const agent = firstOrNull(
    await db
      .select({ id: aiConfigs.id })
      .from(aiConfigs)
      .where(and(eq(aiConfigs.accountId, accountId), eq(aiConfigs.isDefault, true)))
      .orderBy(desc(aiConfigs.isActive))
      .limit(1),
  )
  if (!agent) return null
  const config = await loadAiConfigById(accountId, agent.id, { requireActive: false })
  if (!config) return null
  const r = await generateReply({
    config,
    systemPrompt: [
      'Você extrai os dados de um pedido de cobrança escrito pelo dono de uma loja. Responda SOMENTE um JSON, sem texto em volta, com as chaves:',
      '{"customer": nome do cliente ou null, "phone": telefone do cliente ou null, "value": valor em reais como está no texto ou null, "dueDate": vencimento como está no texto ("10/09", "dia 10", "+7", "2026-09-10") ou null, "description": do que é a cobrança ou null}',
      'Não invente: campo que não está no texto vira null. "dia 10" → "10". "semana que vem" → "+7". "amanhã" → "+1".',
    ].join('\n'),
    messages: [{ role: 'user', content: text }] as unknown as Parameters<typeof generateReply>[0]['messages'],
  })
  const out = (r?.text ?? '').trim()
  const m = /\{[\s\S]*\}/.exec(out)
  if (!m) return null
  try {
    return JSON.parse(m[0]) as RawParsedCommand
  } catch {
    return null
  }
}

async function replyOwner(args: { accountId: string; userId: string; conversationId: string; contactId: string; text: string }): Promise<void> {
  await engineSendText(args)
}

async function latestConversationOf(accountId: string, contactId: string): Promise<string | null> {
  const c = firstOrNull(
    await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.accountId, accountId), eq(conversations.contactId, contactId)))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1),
  )
  return c?.id ?? null
}

/** Cria a cobrança e manda o link ao cliente. Devolve o texto para o dono. */
async function execute(accountId: string, ownerUserId: string, p: Proposal): Promise<string> {
  const created = await createChargeForContact({
    accountId,
    contactId: p.contactId,
    conversationId: await latestConversationOf(accountId, p.contactId),
    connectionId: null,
    value: p.value,
    dueDate: p.dueDate,
    description: p.description,
    origin: 'manual',
    actorLabel: 'pelo dono, via WhatsApp',
    noteSuffix: 'Link enviado ao cliente.',
  })
  if (!created.ok) return `Não consegui gerar: ${created.reason}. Nada foi cobrado.`

  let sentVia: string | null = null
  try {
    const targets = await resolveCollectionTargets(accountId, p.contactId, null)
    if (targets.ok) {
      const firstName = (p.name ?? '').trim().split(/\s+/)[0] || null
      const text = manualChargeMessage(firstName, p.value, p.dueDate, p.description, created.invoiceUrl)
      const convIds = [targets.whatsapp?.conversationId, targets.email?.conversationId].filter((c): c is string => !!c)
      for (const cid of convIds) {
        await sendMessageToConversation(accountId, { conversationId: cid, messageType: 'text', contentText: text, subject: 'Link para pagamento' })
      }
      sentVia = targets.label
    }
  } catch (err) {
    console.error('[owner-command] envio do link falhou:', err instanceof Error ? err.message : err)
  }
  void ownerUserId
  return formatDone(p, created.invoiceUrl, sentVia)
}

/**
 * Trata a mensagem do dono. Devolve true quando respondeu (a IA de
 * atendimento não deve responder por cima). Nunca lança.
 */
export async function handleOwnerCommand(args: {
  accountId: string
  conversationId: string
  /** Contato do DONO (quem escreveu). */
  contactId: string
  ownerUserId: string
  text: string
}): Promise<boolean> {
  const k = key(args.conversationId)
  const say = (text: string) =>
    replyOwner({ accountId: args.accountId, userId: args.ownerUserId, conversationId: args.conversationId, contactId: args.contactId, text })
  try {
    const pending = (await kvGetJson<Pending>(k)) ?? null
    const text = args.text.trim()

    // ---- resposta a uma proposta pendente
    if (pending?.stage === 'confirm' && pending.proposal) {
      if (looksLikeConfirmation(text)) {
        await kvDel(k)
        await say(await execute(args.accountId, args.ownerUserId, pending.proposal))
        return true
      }
      if (looksLikeCancel(text)) {
        await kvDel(k)
        await say('Cancelado. Nada foi cobrado.')
        return true
      }
      // Nem sim nem não: se for um pedido novo, recomeça; senão relembra.
      if (!looksLikeChargeCommand(text)) {
        await say('Ficou pendente: ' + formatProposal(pending.proposal))
        return true
      }
    }
    if (pending?.stage === 'choose' && pending.candidates && pending.draft) {
      const idx = pickCandidateIndex(text, pending.candidates.length)
      if (idx != null) {
        const c = pending.candidates[idx]
        const proposal: Proposal = { contactId: c.id, name: c.name, phone: c.phone, ...pending.draft }
        await kvSetJson(k, { stage: 'confirm', proposal } satisfies Pending, TTL_SECONDS)
        await say(formatProposal(proposal))
        return true
      }
      if (looksLikeCancel(text)) {
        await kvDel(k)
        await say('Cancelado.')
        return true
      }
      if (!looksLikeChargeCommand(text)) {
        await say(formatCandidates(pending.candidates))
        return true
      }
    }

    // ---- pedido novo
    if (!looksLikeChargeCommand(text)) return false
    const raw = await extractWithModel(args.accountId, text)
    if (!raw) {
      await say('Não entendi o pedido. Exemplo: "cria uma cobrança de 150 pro João Silva vencendo dia 10".')
      return true
    }
    const parsed = normalizeParsedCommand(raw)
    if (!parsed.customerQuery) {
      await say('Pra quem é a cobrança? Me manda o nome ou o telefone do cliente.')
      return true
    }
    if (!parsed.value) {
      await say(`Qual o valor da cobrança para ${parsed.customerQuery}? Exemplo: "150,00".`)
      return true
    }
    if (!parsed.dueDate) {
      await say('Não entendi o vencimento. Exemplo: "vencendo dia 10" ou "em 7 dias".')
      return true
    }
    const found = await findContactsByQuery(args.accountId, parsed.customerQuery, 5)
    const draft = { value: parsed.value, dueDate: parsed.dueDate, description: parsed.description }
    if (!found.length) {
      await kvDel(k)
      await say(`Não achei "${parsed.customerQuery}" nos contatos. Me manda o telefone dele (com DDD) que eu cadastro e cobro.`)
      return true
    }
    if (found.length > 1) {
      await kvSetJson(k, { stage: 'choose', candidates: found, draft } satisfies Pending, TTL_SECONDS)
      await say(formatCandidates(found))
      return true
    }
    const proposal: Proposal = { contactId: found[0].id, name: found[0].name, phone: found[0].phone, ...draft }
    await kvSetJson(k, { stage: 'confirm', proposal } satisfies Pending, TTL_SECONDS)
    await say(formatProposal(proposal))
    return true
  } catch (err) {
    console.error('[owner-command] falhou:', err instanceof Error ? err.message : err)
    try {
      await say('Deu um erro aqui ao montar a cobrança. Tenta de novo ou gera pela tela de Cobranças.')
    } catch {
      /* nada */
    }
    return true
  }
}
