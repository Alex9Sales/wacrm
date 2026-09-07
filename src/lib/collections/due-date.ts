// ============================================================
// 🧾 Alterar o vencimento de uma cobrança no Asaas (lacuna 3, 07/09).
//
// Antes: quando o cliente prometia "pago dia 10", a régua dormia até lá, mas a
// cobrança no Asaas ficava com a data velha — e os juros/multa do Asaas
// continuavam contando. Aqui o vencimento é movido de verdade (o Asaas gera
// novo boleto/link), o espelho local é atualizado, a régua dorme até a nova
// data e a conversa ganha uma nota interna. Quem manda é gente (tela) ou a
// configuração explícita `promiseUpdatesDueDate`.
//
// Sem 'server-only' — a resposta do devedor roda no worker.
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, asaasCharges, asaasConnections, collectionsTouches, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { AsaasApiError, updatePaymentDueDate, type AsaasCredential, type AsaasEnv } from '@/lib/asaas/collections'
import { decrypt } from '@/lib/whatsapp/encryption'

export type DueDateOutcome = { ok: true; dueDate: string; invoiceUrl: string | null } | { ok: false; error: string }

const br = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/')

/** Só datas futuras e até 1 ano à frente (ano errado do modelo não move boleto). */
export function validateNewDueDate(dueDate: string, today = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return 'data inválida'
  const base = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  const [y, m, d] = dueDate.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d)
  if (Number.isNaN(t)) return 'data inválida'
  if (t < base) return 'o novo vencimento precisa ser hoje ou depois'
  if (t - base > 365 * 86_400_000) return 'o novo vencimento não pode passar de 1 ano'
  return null
}

export async function changeChargeDueDateCore(args: {
  accountId: string
  chargeId: string
  /** YYYY-MM-DD */
  dueDate: string
  /** "pela Danyela", "pela IA (promessa do cliente)" — vai na nota. */
  actor: string
}): Promise<DueDateOutcome> {
  const invalid = validateNewDueDate(args.dueDate)
  if (invalid) return { ok: false, error: invalid }

  const charge = firstOrNull(
    await db
      .select({
        id: asaasCharges.id,
        asaasId: asaasCharges.asaasId,
        connectionId: asaasCharges.connectionId,
        contactId: asaasCharges.contactId,
        conversationId: asaasCharges.conversationId,
        open: asaasCharges.open,
        dueDate: asaasCharges.dueDate,
        value: asaasCharges.value,
      })
      .from(asaasCharges)
      .where(and(eq(asaasCharges.id, args.chargeId), eq(asaasCharges.accountId, args.accountId)))
      .limit(1),
  )
  if (!charge) return { ok: false, error: 'Cobrança não encontrada.' }
  if (!charge.open) return { ok: false, error: 'Esta cobrança já está paga ou cancelada — não há vencimento para mover.' }
  if (charge.dueDate === args.dueDate) return { ok: false, error: `O vencimento já é ${br(args.dueDate)}.` }

  const conn = firstOrNull(
    await db
      .select({ apiKeyEnc: asaasConnections.apiKeyEnc, environment: asaasConnections.environment, enabled: asaasConnections.enabled })
      .from(asaasConnections)
      .where(and(eq(asaasConnections.id, charge.connectionId), eq(asaasConnections.accountId, args.accountId)))
      .limit(1),
  )
  if (!conn) return { ok: false, error: 'A conta do Asaas desta cobrança não existe mais no CRM.' }
  let cred: AsaasCredential
  try {
    cred = { apiKey: decrypt(conn.apiKeyEnc), environment: conn.environment as AsaasEnv }
  } catch {
    return { ok: false, error: 'A chave do Asaas não pôde ser lida. Cadastre a chave de novo.' }
  }

  let updated
  try {
    updated = await updatePaymentDueDate(cred, charge.asaasId, args.dueDate)
  } catch (err) {
    return { ok: false, error: err instanceof AsaasApiError ? err.message : 'O Asaas não aceitou a alteração.' }
  }

  const now = new Date().toISOString()
  await db
    .update(asaasCharges)
    .set({
      dueDate: (updated.dueDate ?? args.dueDate).slice(0, 10),
      status: updated.status ?? 'PENDING',
      invoiceUrl: updated.invoiceUrl ?? null,
      bankSlipUrl: updated.bankSlipUrl ?? null,
      updatedAt: now,
    })
    .where(eq(asaasCharges.id, charge.id))

  // A régua dorme até a virada do dia seguinte ao novo vencimento (horário do
  // Brasil): cobrar "vencida" no próprio dia da data que nós mesmos movemos
  // seria contradizer o combinado.
  if (charge.contactId) {
    const [y, m, d] = args.dueDate.split('-').map(Number)
    const until = new Date(Date.UTC(y, m - 1, d + 2, 3, 0, 0)).toISOString()
    await db
      .insert(collectionsTouches)
      .values({ accountId: args.accountId, contactId: charge.contactId, snoozeUntil: until, snoozeReason: `Vencimento alterado para ${br(args.dueDate)}`, updatedAt: now })
      .onConflictDoUpdate({
        target: [collectionsTouches.accountId, collectionsTouches.contactId],
        set: { snoozeUntil: until, snoozeReason: `Vencimento alterado para ${br(args.dueDate)}`, updatedAt: now },
      })
  }

  if (charge.conversationId) {
    try {
      await db.insert(messages).values({
        conversationId: charge.conversationId,
        senderType: 'agent',
        contentType: 'text',
        contentText: `🧾 Vencimento da cobrança de ${Number(charge.value ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} alterado no Asaas de ${charge.dueDate ? br(charge.dueDate) : '—'} para ${br(args.dueDate)} ${args.actor}.${updated.invoiceUrl ? ' Novo link gerado.' : ''} A régua dorme até lá.`,
        isInternal: true,
        status: 'sent',
      })
    } catch (err) {
      console.error('[cobranca] nota interna do vencimento falhou:', err instanceof Error ? err.message : err)
    }
  }

  return { ok: true, dueDate: (updated.dueDate ?? args.dueDate).slice(0, 10), invoiceUrl: updated.invoiceUrl ?? null }
}
