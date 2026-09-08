// ============================================================
// 🧾 Emitir cobrança no Asaas — pela IA (`criar_cobranca`) ou à mão.
//
// Núcleo comum (`createChargeForContact`):
//   1. duplicata na mesma conversa/contato reaproveita o link (lição do pedido 3×);
//   2. cria/reencontra o cliente no Asaas e cria a cobrança;
//   3. grava em asaas_charges com a origem ('ai' | 'manual') — a cobrança já
//      nasce dentro do ciclo: se vencer a régua pega, se pagar o webhook fecha;
//   4. nota interna com o que foi feito, sempre que há conversa.
//
// Em cima dele, a IA (`emitChargeFromDirective`) passa pelas travas
// determinísticas (emit-rules: teto por conta, janela de vencimento, descrição)
// e avisa uma pessoa quando não pode. A emissão manual (Cobranças → Nova
// cobrança) não tem teto: quem decide é gente.
//
// Nunca lança: o atendimento não pode cair por causa de cobrança.
// Sem 'server-only' — roda no worker.
// ============================================================

import { and, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm'

import { db, asaasCharges, asaasConnections, contacts, member, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { createPayment, findOrCreateCustomer, type AsaasCredential, type AsaasEnv } from '@/lib/asaas/collections'
import { postInternalNote } from '@/lib/ai/close-actions'
import { notifyUsers } from '@/lib/orchestration/actions'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { decrypt } from '@/lib/whatsapp/encryption'
import { toBrE164IfNational } from '@/lib/whatsapp/phone-utils'

import { findDocumentInText } from './document'
import { EMIT_DEFAULTS, findDuplicateCharge, parseDueDate, parseValue, validateEmit } from './emit-rules'
import { normalizeSettings } from './rules'

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const br = (ymd: string) => ymd.slice(0, 10).split('-').reverse().join('/')

// ---------------------------------------------------------------- núcleo

export interface CreateChargeInput {
  accountId: string
  contactId: string
  /** Conversa onde a nota interna entra (null = sem nota). */
  conversationId: string | null
  /** Conta do Asaas específica; null = a primeira ligada. */
  connectionId: string | null
  value: number
  /** YYYY-MM-DD */
  dueDate: string
  description: string
  origin: 'ai' | 'manual'
  /** "pela IA" / "por Danyela" — entra na nota interna. */
  actorLabel: string
  /** Complemento da nota (ex.: "Link enviado na conversa."). */
  noteSuffix?: string
  /** CPF/CNPJ (só dígitos) que o dono/cliente mandou agora. Sem isso, usa o
   *  último documento visto na carteira para o contato. O Asaas de produção
   *  exige documento pra gerar qualquer cobrança (08/09). */
  cpfCnpj?: string | null
}

export type CreateChargeOutcome =
  | { ok: true; chargeId: string; invoiceUrl: string; reused: boolean; connectionLabel: string }
  | { ok: false; reason: string; needsDocument?: boolean }

/** Último CPF/CNPJ que a carteira viu para este contato (cobrança nossa ou sincronizada). */
export async function knownDocumentFor(accountId: string, contactId: string): Promise<string | null> {
  const row = firstOrNull(
    await db
      .select({ doc: asaasCharges.cpfCnpj })
      .from(asaasCharges)
      .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.contactId, contactId), isNotNull(asaasCharges.cpfCnpj)))
      .orderBy(desc(asaasCharges.createdAt))
      .limit(1),
  )
  const d = (row?.doc ?? '').replace(/\D/g, '')
  return d.length === 11 || d.length === 14 ? d : null
}

const NEEDS_DOCUMENT_RE = /CPF ou CNPJ|cpfCnpj/i

export async function createChargeForContact(input: CreateChargeInput): Promise<CreateChargeOutcome> {
  try {
    const conn = firstOrNull(
      await db
        .select()
        .from(asaasConnections)
        .where(
          and(
            eq(asaasConnections.accountId, input.accountId),
            eq(asaasConnections.enabled, true),
            ...(input.connectionId ? [eq(asaasConnections.id, input.connectionId)] : []),
          ),
        )
        .orderBy(asaasConnections.createdAt)
        .limit(1),
    )
    if (!conn) {
      return { ok: false, reason: input.connectionId ? 'a conta do Asaas escolhida não está ligada' : 'nenhuma conta do Asaas conectada em Cobranças' }
    }

    // Duplicata: mesmo contato, mesmo valor, aberta, últimas 6h → reaproveita.
    const recent = await db
      .select({ id: asaasCharges.id, value: asaasCharges.value, createdAt: asaasCharges.createdAt, open: asaasCharges.open, invoiceUrl: asaasCharges.invoiceUrl })
      .from(asaasCharges)
      .where(
        and(
          eq(asaasCharges.accountId, input.accountId),
          eq(asaasCharges.contactId, input.contactId),
          inArray(asaasCharges.origin, ['ai', 'manual']),
          gte(asaasCharges.createdAt, new Date(Date.now() - 6 * 3_600_000).toISOString()),
        ),
      )
      .orderBy(desc(asaasCharges.createdAt))
      .limit(10)
    const dup = findDuplicateCharge(
      recent.map((r) => ({ value: Number(r.value), createdAt: r.createdAt, open: r.open, invoiceUrl: r.invoiceUrl })),
      input.value,
    )
    if (dup?.invoiceUrl) {
      const row = recent.find((r) => r.invoiceUrl === dup.invoiceUrl)
      if (input.conversationId) {
        await postInternalNote({
          conversationId: input.conversationId,
          text: `🧾 Já existia uma cobrança aberta de ${brl(input.value)} criada há pouco para este contato — o mesmo link foi reaproveitado, nada foi criado em dobro.`,
        }).catch(() => {})
      }
      return { ok: true, chargeId: row?.id ?? '', invoiceUrl: dup.invoiceUrl, reused: true, connectionLabel: conn.label }
    }

    const contact = firstOrNull(
      await db
        .select({ name: contacts.name, phone: contacts.phone, email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.id, input.contactId), eq(contacts.accountId, input.accountId)))
        .limit(1),
    )
    if (!contact) return { ok: false, reason: 'contato não encontrado' }

    let cred: AsaasCredential
    try {
      cred = { apiKey: decrypt(conn.apiKeyEnc), environment: conn.environment as AsaasEnv }
    } catch {
      return { ok: false, reason: 'a chave do Asaas salva não pôde ser lida' }
    }

    const phoneDigits = (contact.phone ?? '').replace(/\D/g, '')
    const docNow = (input.cpfCnpj ?? '').replace(/\D/g, '')
    const cpfCnpj = docNow.length === 11 || docNow.length === 14 ? docNow : await knownDocumentFor(input.accountId, input.contactId)
    const customer = await findOrCreateCustomer(cred, {
      name: (contact.name || contact.email || contact.phone || 'Cliente').trim(),
      mobilePhone: phoneDigits ? toBrE164IfNational(phoneDigits) : '',
      email: contact.email,
      cpfCnpj,
      externalReference: input.contactId,
    })

    // Com documento, UNDEFINED deixa o cliente escolher Pix/boleto na página do
    // Asaas; sem documento tenta Pix (sandbox aceita; produção recusa e a
    // recusa volta como needsDocument pra quem chamou pedir o CPF/CNPJ).
    const billingType = customer.cpfCnpj ? 'UNDEFINED' : 'PIX'

    const payment = await createPayment(cred, {
      customer: customer.id,
      value: input.value,
      dueDate: input.dueDate,
      description: input.description,
      billingType,
      externalReference: input.conversationId ?? input.contactId,
    })
    if (!payment.invoiceUrl) return { ok: false, reason: 'o Asaas criou a cobrança mas não devolveu o link (id ' + payment.id + ')' }

    const inserted = firstOrNull(
      await db
        .insert(asaasCharges)
        .values({
          accountId: input.accountId,
          connectionId: conn.id,
          conversationId: input.conversationId,
          asaasId: payment.id,
          asaasCustomerId: payment.customer,
          customerName: contact.name,
          cpfCnpj: customer.cpfCnpj ?? cpfCnpj ?? null,
          phone: contact.phone,
          email: contact.email,
          value: String(input.value),
          dueDate: input.dueDate,
          status: payment.status,
          billingType: payment.billingType ?? billingType,
          description: input.description,
          invoiceUrl: payment.invoiceUrl,
          bankSlipUrl: payment.bankSlipUrl ?? null,
          contactId: input.contactId,
          matchedBy: 'manual',
          origin: input.origin,
          open: true,
        })
        .returning({ id: asaasCharges.id }),
    )

    if (input.conversationId) {
      await postInternalNote({
        conversationId: input.conversationId,
        text: `🧾 Cobrança gerada no Asaas ${input.actorLabel}: ${brl(input.value)} · vence ${br(input.dueDate)} · "${input.description}" · conta ${conn.label}.${input.noteSuffix ? ` ${input.noteSuffix}` : ''} Se o cliente pagar, o webhook fecha sozinho.`,
      }).catch(() => {})
    }

    return { ok: true, chargeId: inserted?.id ?? '', invoiceUrl: payment.invoiceUrl, reused: false, connectionLabel: conn.label }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'falha inesperada'
    console.error('[cobranca] criar falhou:', reason)
    return { ok: false, reason, needsDocument: NEEDS_DOCUMENT_RE.test(reason) }
  }
}

// ---------------------------------------------------------- pela IA

export interface EmitInput {
  accountId: string
  contactId: string
  conversationId: string
  agentId: string | null
  valueRaw: string
  dueRaw: string
  description: string
}

export type EmitOutcome =
  | { ok: true; invoiceUrl: string; value: number; dueDate: string; reused: boolean }
  | { ok: false; reason: string; needsDocument?: boolean }

/** A IA escreveu [[COBRAR:…]]: as travas decidem; falhou → nota + aviso, a resposta sai sem link
 *  (com `needsDocument` quem responde pede o CPF/CNPJ ao cliente em vez de prometer link). */
export async function emitChargeFromDirective(input: EmitInput): Promise<EmitOutcome> {
  const fail = async (reason: string, needsDocument = false): Promise<EmitOutcome> => {
    await postInternalNote({
      conversationId: input.conversationId,
      text: needsDocument
        ? `🧾 A IA tentou gerar uma cobrança e o Asaas exigiu CPF/CNPJ do cliente (${reason}). A IA pediu o documento na conversa; quando ele mandar, a próxima tentativa passa.`
        : `🧾 A IA tentou gerar uma cobrança e NÃO gerou: ${reason}. O cliente pode estar esperando o link — assuma daqui.`,
    }).catch(() => {})
    if (!needsDocument) await alertTeam(input, `Cobrança não gerada — ${reason}`)
    return { ok: false, reason, needsDocument }
  }

  try {
    const settings = await getAccountSettings(input.accountId)
    const guard = { ...EMIT_DEFAULTS, maxValue: normalizeSettings(settings.collections).emitMaxValue }

    const value = parseValue(input.valueRaw)
    const dueDate = parseDueDate(input.dueRaw)
    const description = input.description.trim() || 'Cobrança'
    const verdict = validateEmit({ value, dueDate, description }, guard)
    if (!verdict.ok) return fail(verdict.reason)

    // 08/09: se o cliente mandou o CPF/CNPJ na conversa (o Asaas de produção
    // exige), ele vai junto — senão a cobrança volta recusada e a IA fica
    // pedindo o documento que já está no histórico.
    const cpfCnpj = await documentFromConversation(input.conversationId)
    const created = await createChargeForContact({
      accountId: input.accountId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      connectionId: null,
      value: value!,
      dueDate: dueDate!,
      description,
      origin: 'ai',
      actorLabel: 'pela IA',
      noteSuffix: 'Link enviado na conversa.',
      cpfCnpj,
    })
    if (!created.ok) return fail(created.reason, created.needsDocument === true)
    return { ok: true, invoiceUrl: created.invoiceUrl, value: value!, dueDate: dueDate!, reused: created.reused }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'falha inesperada'
    console.error('[criar_cobranca] falhou:', reason)
    return fail(reason)
  }
}

/** CPF/CNPJ válido nas últimas mensagens do CLIENTE nesta conversa (só dígitos) ou null. */
export async function documentFromConversation(conversationId: string): Promise<string | null> {
  try {
    const rows = await db
      .select({ text: messages.contentText })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.senderType, 'customer'), eq(messages.isInternal, false)))
      .orderBy(desc(messages.createdAt))
      .limit(8)
    for (const r of rows) {
      const doc = findDocumentInText(r.text)
      if (doc) return doc
    }
  } catch {
    /* sem documento → segue sem */
  }
  return null
}

async function alertTeam(input: EmitInput, title: string): Promise<void> {
  try {
    const who = firstOrNull(
      await db.select({ name: contacts.name, phone: contacts.phone }).from(contacts).where(eq(contacts.id, input.contactId)).limit(1),
    )
    const rows = await db.select({ userId: member.userId }).from(member).where(eq(member.organizationId, input.accountId))
    await notifyUsers({
      accountId: input.accountId,
      userIds: rows.map((r) => r.userId),
      type: 'agent_action',
      title: `${title} — ${who?.name || who?.phone || 'cliente'}`,
      body: 'A IA não conseguiu gerar a cobrança no Asaas. O cliente pode estar esperando o link: gere você e mande na conversa.',
      contactId: input.contactId,
      conversationId: input.conversationId,
    })
  } catch (err) {
    console.error('[criar_cobranca] aviso ao time falhou:', err instanceof Error ? err.message : err)
  }
}
