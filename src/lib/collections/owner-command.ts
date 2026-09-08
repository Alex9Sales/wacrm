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

import { db, aiConfigs, contacts, conversations } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadAiConfigById } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { kvDel, kvGetJson, kvSetJson } from '@/lib/ai/reply-marker'
import { findContactsByQuery, type FoundContact } from '@/lib/contacts/search'
import { engineSendText } from '@/lib/flows/meta-send'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { phonesMatch } from '@/lib/whatsapp/phone-utils'

import { findDocumentInText } from './document'
import { createChargeForContact } from './emit'
import { manualChargeMessage, parseDueDate, parseValue } from './emit-rules'
import {
  DUE_DEFAULTED_NOTE,
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
  /** collect = pedido em pedaços: guarda o texto acumulado até ter cliente+valor+vencimento.
   *  document = o Asaas exigiu CPF/CNPJ (produção): esperando o documento pra gerar. */
  stage: 'choose' | 'confirm' | 'collect' | 'document'
  candidates?: FoundContact[]
  draft?: Draft
  proposal?: Proposal
  partialText?: string
}

interface Draft {
  value: number
  dueDate: string
  description: string
  dueDefaulted?: boolean
}

/**
 * Ajuste em cima de um rascunho/proposta ("vence amanhã", "valor 150", "é o
 * botijão"): o modelo extrai só o que veio; campo ausente fica como estava.
 * Nada extraído → null (quem chamou decide o que dizer).
 */
async function tweakFields<T extends { value: number; dueDate: string; description: string; dueDefaulted?: boolean }>(
  accountId: string,
  base: T,
  text: string,
): Promise<T | null> {
  const raw = await extractWithModel(accountId, text)
  if (!raw) return null
  const due = raw.dueDate ? parseDueDate(String(raw.dueDate)) : null
  const value = raw.value == null ? null : parseValue(String(raw.value))
  const description = (raw.description ?? '').toString().trim()
  if (!due && !value && !description) return null
  return {
    ...base,
    ...(due ? { dueDate: due, dueDefaulted: false } : {}),
    ...(value ? { value } : {}),
    ...(description ? { description } : {}),
  }
}

const proposalText = (p: Proposal & { dueDefaulted?: boolean }) => formatProposal(p) + (p.dueDefaulted ? `\n${DUE_DEFAULTED_NOTE}` : '')

/**
 * "Me manda o telefone dele que eu cadastro e cobro" — cumpre a promessa:
 * cria o contato com o nome e o telefone que o dono mandou. BR nacional (10–11
 * dígitos) ganha o 55. Conflito (já existe noutro formato) → null e o fluxo
 * pede de novo. Nunca lança.
 */
async function createContactFromOwner(accountId: string, userId: string, name: string | null, phoneDigits: string): Promise<FoundContact | null> {
  const d = phoneDigits.replace(/\D/g, '')
  const phone = /^55\d{10,11}$/.test(d) ? d : d.length === 10 || d.length === 11 ? `55${d}` : d
  if (phone.length < 10) return null
  try {
    const row = firstOrNull(
      await db
        .insert(contacts)
        .values({ accountId, userId, phone, name: (name ?? '').trim() || null })
        .onConflictDoNothing()
        .returning({ id: contacts.id, name: contacts.name, phone: contacts.phone, email: contacts.email }),
    )
    if (row) console.log(`[owner-command] contato cadastrado pelo dono: ${row.id}`)
    return row ?? null
  } catch (err) {
    console.error('[owner-command] cadastrar contato falhou:', err instanceof Error ? err.message : err)
    return null
  }
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

/** Cria a cobrança e manda o link ao cliente. Devolve o texto para o dono
 *  (e `needsDocument` quando o Asaas exigiu CPF/CNPJ — o chamador pede). */
async function execute(accountId: string, ownerUserId: string, p: Proposal, cpfCnpj?: string | null): Promise<{ text: string; needsDocument: boolean }> {
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
    cpfCnpj: cpfCnpj ?? null,
  })
  if (!created.ok) {
    if (created.needsDocument) {
      return {
        text: `O Asaas exige CPF ou CNPJ pra gerar a cobrança de ${p.name?.trim() || p.phone}. Me manda o documento (só números) que eu cadastro no Asaas — com os avisos deles desligados — e gero. Ou responda NÃO pra cancelar.`,
        needsDocument: true,
      }
    }
    return { text: `Não consegui gerar: ${created.reason}. Nada foi cobrado.`, needsDocument: false }
  }

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
  return { text: formatDone(p, created.invoiceUrl, sentVia), needsDocument: false }
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

    // ---- o Asaas exigiu CPF/CNPJ (produção, 08/09): esperando o documento
    if (pending?.stage === 'document' && pending.proposal) {
      if (looksLikeCancel(text)) {
        await kvDel(k)
        await say('Cancelado. Nada foi cobrado.')
        return true
      }
      const doc = findDocumentInText(text)
      if (doc) {
        const r = await execute(args.accountId, args.ownerUserId, pending.proposal, doc)
        if (!r.needsDocument) await kvDel(k)
        await say(r.text)
        return true
      }
      if (!looksLikeChargeCommand(text)) {
        await say(`Preciso do CPF ou CNPJ de ${pending.proposal.name?.trim() || pending.proposal.phone} (11 ou 14 números) pra gerar no Asaas — ou responda NÃO pra cancelar.`)
        return true
      }
    }

    // ---- resposta a uma proposta pendente
    if (pending?.stage === 'confirm' && pending.proposal) {
      if (looksLikeConfirmation(text)) {
        const r = await execute(args.accountId, args.ownerUserId, pending.proposal)
        if (r.needsDocument) {
          await kvSetJson(k, { stage: 'document', proposal: pending.proposal } satisfies Pending, TTL_SECONDS)
        } else {
          await kvDel(k)
        }
        await say(r.text)
        return true
      }
      if (looksLikeCancel(text)) {
        await kvDel(k)
        await say('Cancelado. Nada foi cobrado.')
        return true
      }
      // Nem sim nem não: ajuste ("vence amanhã", "valor 150") atualiza a
      // proposta; pedido novo recomeça; o resto só relembra.
      if (!looksLikeChargeCommand(text)) {
        const tweaked = await tweakFields(args.accountId, pending.proposal, text)
        if (tweaked) {
          await kvSetJson(k, { stage: 'confirm', proposal: tweaked } satisfies Pending, TTL_SECONDS)
          await say(proposalText(tweaked))
          return true
        }
        await say('Ficou pendente: ' + proposalText(pending.proposal))
        return true
      }
    }
    if (pending?.stage === 'choose' && pending.candidates && pending.draft) {
      // "2" pode vir com ajuste junto ("2" / "Para vencimento amanhã", 08/09):
      // o índice é a primeira linha; o resto ajusta o rascunho.
      const [firstLine = '', ...restLines] = text.split('\n')
      const idx = pickCandidateIndex(firstLine.trim(), pending.candidates.length)
      if (idx != null) {
        const c = pending.candidates[idx]
        const extra = restLines.join('\n').trim()
        const draft = extra ? (await tweakFields(args.accountId, pending.draft, extra)) ?? pending.draft : pending.draft
        const proposal: Proposal & { dueDefaulted?: boolean } = { contactId: c.id, name: c.name, phone: c.phone, ...draft }
        await kvSetJson(k, { stage: 'confirm', proposal } satisfies Pending, TTL_SECONDS)
        await say(proposalText(proposal))
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

    // ---- pedido novo, ou continuação de um pedido em pedaços (08/09: o dono
    // manda "cria uma cobrança" / "pra Danyela" / "5 reais" / "amanhã" em
    // balões separados, e responde ao "qual o valor?" com outro balão).
    let request = text
    if (pending?.stage === 'collect' && pending.partialText) {
      if (looksLikeCancel(text)) {
        await kvDel(k)
        await say('Cancelado. Nada foi cobrado.')
        return true
      }
      // Pedido novo do zero substitui; senão é continuação → junta.
      request = looksLikeChargeCommand(text) ? text : `${pending.partialText}\n${text}`
    }
    if (!looksLikeChargeCommand(request)) return false
    const remember = () => kvSetJson(k, { stage: 'collect', partialText: request } satisfies Pending, TTL_SECONDS)
    const raw = await extractWithModel(args.accountId, request)
    if (!raw) {
      await remember()
      await say('Não entendi o pedido. Exemplo: "cria uma cobrança de 150 pro João Silva vencendo dia 10".')
      return true
    }
    const parsed = normalizeParsedCommand(raw)
    if (!parsed.customerQuery) {
      await remember()
      await say('Pra quem é a cobrança? Me manda o nome ou o telefone do cliente.')
      return true
    }
    if (!parsed.value) {
      await remember()
      await say(`Qual o valor da cobrança para ${parsed.customerQuery}? Exemplo: "150,00".`)
      return true
    }
    if (!parsed.dueDate) {
      await remember()
      await say('Não entendi o vencimento. Exemplo: "vencendo dia 10" ou "em 7 dias".')
      return true
    }
    let found = await findContactsByQuery(args.accountId, parsed.customerQuery, 5)
    const draft: Draft = { value: parsed.value, dueDate: parsed.dueDate, description: parsed.description, dueDefaulted: parsed.dueDefaulted }
    if (!found.length) {
      // Dono mandou o telefone (junto ou depois do "me manda o telefone")?
      // Então cadastra — com o nome que ele deu — e segue pra proposta.
      const phoneDigits = String(raw.phone ?? '').replace(/\D/g, '')
      if (phoneDigits.length >= 10) {
        const created = await createContactFromOwner(args.accountId, args.ownerUserId, raw.customer ?? null, phoneDigits)
        if (created) found = [created]
      }
    }
    if (!found.length) {
      await remember()
      await say(`Não achei "${parsed.customerQuery}" nos contatos. Me manda o telefone dele (com DDD) que eu cadastro e cobro.`)
      return true
    }
    if (found.length > 1) {
      await kvSetJson(k, { stage: 'choose', candidates: found, draft } satisfies Pending, TTL_SECONDS)
      await say(formatCandidates(found))
      return true
    }
    const proposal: Proposal & { dueDefaulted?: boolean } = { contactId: found[0].id, name: found[0].name, phone: found[0].phone, ...draft }
    await kvSetJson(k, { stage: 'confirm', proposal } satisfies Pending, TTL_SECONDS)
    await say(proposalText(proposal))
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
