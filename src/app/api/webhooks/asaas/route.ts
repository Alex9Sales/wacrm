// ============================================================
// Webhook do Asaas — confirmação de pagamento da assinatura do FluxiaCRM.
//   • POST — recebe o evento; se for pagamento confirmado, vira o billing da
//            org pra status='active' (some a tela de "trial acabou").
//   • GET  — health check (200).
//
// Autenticação: o Asaas manda o token configurado no cadastro do webhook no
// header `asaas-access-token`. Validamos contra ASAAS_WEBHOOK_TOKEN. Sem env
// (piloto), processa com aviso. Responde 200 rápido e ativa em `after`.
// ============================================================

import { NextResponse, after } from 'next/server'
import { eq } from 'drizzle-orm'

import { db, organizationBilling } from '@/db'
import { firstOrNull } from '@/db/helpers'
import {
  isActivateEvent,
  extractOrgRef,
  addOneMonthISO,
} from '@/lib/billing/webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET() {
  return NextResponse.json({ status: 'ok' }, { status: 200 })
}

export async function POST(request: Request) {
  const rawBody = await request.text()

  const expected = process.env.ASAAS_WEBHOOK_TOKEN
  const provided = request.headers.get('asaas-access-token')
  if (expected) {
    if (provided !== expected) {
      console.warn('[webhooks/asaas] rejected: bad asaas-access-token')
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }
  } else {
    console.warn(
      '[webhooks/asaas] sem ASAAS_WEBHOOK_TOKEN no ambiente — processando SEM ' +
        'validar o token (piloto). Configure o token p/ fechar.',
    )
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const b = body as { event?: unknown; payment?: unknown } | null
  if (!isActivateEvent(b?.event)) {
    // Outros eventos (criado, vencido, etc.) — ignorados por ora (v1 só ativa).
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  after(() => activateFromPayment(b?.payment))

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

/** Ativa a conta cujo pagamento foi confirmado. Best-effort (não derruba). */
async function activateFromPayment(payment: unknown): Promise<void> {
  try {
    const { externalReference, subscriptionId } = extractOrgRef(payment)
    const orgId = await resolveOrgId(externalReference, subscriptionId)
    if (!orgId) {
      console.warn('[webhooks/asaas] pagamento sem org correspondente', {
        externalReference,
        subscriptionId,
      })
      return
    }
    const p = (payment ?? {}) as Record<string, unknown>
    const dueAt = addOneMonthISO(
      typeof p.dueDate === 'string' ? p.dueDate : undefined,
    )
    const set: Partial<typeof organizationBilling.$inferInsert> = {
      status: 'active',
      dueAt,
      updatedAt: new Date().toISOString(),
    }
    if (subscriptionId) set.asaasSubscriptionId = subscriptionId
    await db
      .update(organizationBilling)
      .set(set)
      .where(eq(organizationBilling.organizationId, orgId))
    console.log('[webhooks/asaas] conta ativada:', orgId)
  } catch (err) {
    console.error('[webhooks/asaas] activate error:', err)
  }
}

/** Acha a org: 1º pela externalReference (id da org), senão pela assinatura. */
async function resolveOrgId(
  externalReference: string | null,
  subscriptionId: string | null,
): Promise<string | null> {
  if (externalReference && UUID_RE.test(externalReference)) {
    const row = firstOrNull(
      await db
        .select({ id: organizationBilling.organizationId })
        .from(organizationBilling)
        .where(eq(organizationBilling.organizationId, externalReference))
        .limit(1),
    )
    if (row) return row.id
  }
  if (subscriptionId) {
    const row = firstOrNull(
      await db
        .select({ id: organizationBilling.organizationId })
        .from(organizationBilling)
        .where(eq(organizationBilling.asaasSubscriptionId, subscriptionId))
        .limit(1),
    )
    if (row) return row.id
  }
  return null
}
