// ============================================================
// 🧾 Emitir cobrança no Asaas durante o atendimento (`criar_cobranca`).
//
// A IA emite [[COBRAR:valor|vencimento|descrição]]. Aqui:
//   1. as travas determinísticas decidem (emit-rules) — valor máximo, janela
//      de vencimento, descrição; acima do teto vira aviso pra uma pessoa;
//   2. duplicata na mesma conversa reaproveita o link (lição do pedido 3×);
//   3. cria/reencontra o cliente no Asaas e cria a cobrança;
//   4. grava em asaas_charges com origin='ai' — a cobrança já nasce dentro do
//      ciclo: se vencer a régua pega, se pagar o webhook fecha;
//   5. nota interna com o que foi feito, sempre.
//
// Nunca lança: o atendimento não pode cair por causa de cobrança. Falhou →
// { ok:false, reason } e nota interna; a IA já disse "segue o link", então
// quem assume é uma pessoa.
// Sem 'server-only' — roda no worker.
// ============================================================

import { and, desc, eq, gte } from 'drizzle-orm'

import { db, asaasCharges, asaasConnections, contacts, member } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { createPayment, findOrCreateCustomer, type AsaasCredential, type AsaasEnv } from '@/lib/asaas/collections'
import { postInternalNote } from '@/lib/ai/close-actions'
import { notifyUsers } from '@/lib/orchestration/actions'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { decrypt } from '@/lib/whatsapp/encryption'
import { toBrE164IfNational } from '@/lib/whatsapp/phone-utils'

import { EMIT_DEFAULTS, findDuplicateCharge, parseDueDate, parseValue, validateEmit } from './emit-rules'
import { normalizeSettings } from './rules'

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
  | { ok: false; reason: string }

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const br = (ymd: string) => ymd.slice(0, 10).split('-').reverse().join('/')

export async function emitChargeFromDirective(input: EmitInput): Promise<EmitOutcome> {
  const fail = async (reason: string, notify = true): Promise<EmitOutcome> => {
    await postInternalNote({
      conversationId: input.conversationId,
      text: `🧾 A IA tentou gerar uma cobrança e NÃO gerou: ${reason}. O cliente pode estar esperando o link — assuma daqui.`,
    }).catch(() => {})
    if (notify) await alertTeam(input, `Cobrança não gerada — ${reason}`)
    return { ok: false, reason }
  }

  try {
    const settings = await getAccountSettings(input.accountId)
    const guard = { ...EMIT_DEFAULTS, maxValue: normalizeSettings(settings.collections).emitMaxValue }

    const value = parseValue(input.valueRaw)
    const dueDate = parseDueDate(input.dueRaw)
    const description = input.description.trim() || 'Cobrança'
    const verdict = validateEmit({ value, dueDate, description }, guard)
    if (!verdict.ok) return fail(verdict.reason)

    const conn = firstOrNull(
      await db
        .select()
        .from(asaasConnections)
        .where(and(eq(asaasConnections.accountId, input.accountId), eq(asaasConnections.enabled, true)))
        .orderBy(asaasConnections.createdAt)
        .limit(1),
    )
    if (!conn) return fail('nenhuma conta do Asaas conectada em Cobranças')

    // Duplicata: mesma conversa, mesmo valor, aberta, últimas 6h → reaproveita.
    const recent = await db
      .select({ value: asaasCharges.value, createdAt: asaasCharges.createdAt, open: asaasCharges.open, invoiceUrl: asaasCharges.invoiceUrl })
      .from(asaasCharges)
      .where(
        and(
          eq(asaasCharges.accountId, input.accountId),
          eq(asaasCharges.contactId, input.contactId),
          eq(asaasCharges.origin, 'ai'),
          gte(asaasCharges.createdAt, new Date(Date.now() - 6 * 3_600_000).toISOString()),
        ),
      )
      .orderBy(desc(asaasCharges.createdAt))
      .limit(10)
    const dup = findDuplicateCharge(
      recent.map((r) => ({ value: Number(r.value), createdAt: r.createdAt, open: r.open, invoiceUrl: r.invoiceUrl })),
      value!,
    )
    if (dup?.invoiceUrl) {
      await postInternalNote({
        conversationId: input.conversationId,
        text: `🧾 A IA pediu uma cobrança de ${brl(value!)} que já existia nesta conversa — o mesmo link foi reenviado, nada foi criado em dobro.`,
      }).catch(() => {})
      return { ok: true, invoiceUrl: dup.invoiceUrl, value: value!, dueDate: dueDate!, reused: true }
    }

    const contact = firstOrNull(
      await db
        .select({ name: contacts.name, phone: contacts.phone, email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.id, input.contactId), eq(contacts.accountId, input.accountId)))
        .limit(1),
    )
    if (!contact) return fail('contato não encontrado')

    let cred: AsaasCredential
    try {
      cred = { apiKey: decrypt(conn.apiKeyEnc), environment: conn.environment as AsaasEnv }
    } catch {
      return fail('a chave do Asaas salva não pôde ser lida')
    }

    const customer = await findOrCreateCustomer(cred, {
      name: (contact.name || contact.phone).trim(),
      mobilePhone: toBrE164IfNational(contact.phone),
      email: contact.email,
      externalReference: input.contactId,
    })

    // Sem CPF/CNPJ no contato o boleto não sai; Pix não exige. Quando houver
    // CPF no cadastro, UNDEFINED deixa o cliente escolher na página do Asaas.
    const billingType = customer.cpfCnpj ? 'UNDEFINED' : 'PIX'

    const payment = await createPayment(cred, {
      customer: customer.id,
      value: value!,
      dueDate: dueDate!,
      description,
      billingType,
      externalReference: input.conversationId,
    })
    if (!payment.invoiceUrl) return fail('o Asaas criou a cobrança mas não devolveu o link (id ' + payment.id + ')')

    await db.insert(asaasCharges).values({
      accountId: input.accountId,
      connectionId: conn.id,
      conversationId: input.conversationId,
      asaasId: payment.id,
      asaasCustomerId: payment.customer,
      customerName: contact.name,
      phone: contact.phone,
      email: contact.email,
      value: String(value),
      dueDate: dueDate!,
      status: payment.status,
      billingType: payment.billingType ?? billingType,
      description,
      invoiceUrl: payment.invoiceUrl,
      bankSlipUrl: payment.bankSlipUrl ?? null,
      contactId: input.contactId,
      matchedBy: 'manual',
      origin: 'ai',
      open: true,
    })

    await postInternalNote({
      conversationId: input.conversationId,
      text: `🧾 Cobrança gerada no Asaas pela IA: ${brl(value!)} · vence ${br(dueDate!)} · "${description}" · conta ${conn.label}. Link enviado na conversa. Se o cliente pagar, o webhook fecha sozinho.`,
    }).catch(() => {})

    return { ok: true, invoiceUrl: payment.invoiceUrl, value: value!, dueDate: dueDate!, reused: false }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'falha inesperada'
    console.error('[criar_cobranca] falhou:', reason)
    return fail(reason)
  }
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
