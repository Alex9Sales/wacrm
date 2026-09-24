// ============================================================
// POST /api/admin/clients/[orgId]/subscription — cria a assinatura do cliente
// no Asaas e amarra na conta (24/09).
//
// ⚠️ ISTO EMITE COBRANÇA DE VERDADE: o Asaas gera o boleto e notifica o
// cliente. Por isso:
//   • só platform-admin;
//   • recusa se a conta JÁ tem assinatura vinculada (nada de cobrar duas
//     vezes o mesmo cliente por um clique repetido);
//   • o cliente precisa existir no Asaas — este endpoint NÃO cria cadastro
//     no escuro: ou veio o customer vinculado, ou o CPF/CNPJ acha lá.
//
// Body: { value, first_due_date, description?, future_value?, future_from? }
// O degrau futuro (ex.: R$ 497 até dezembro, R$ 697 a partir de 30/01/2027)
// fica registrado nas notas — o Asaas não agenda mudança de valor, e alguém
// precisa lembrar. Melhor escrito na conta do que só na cabeça.
// ============================================================

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db, organizationBilling } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { toErrorResponse } from '@/lib/auth/account'
import { requirePlatformAdmin } from '@/lib/auth/platform'
import { AsaasError, createSubscription, findCustomerByCpfCnpj } from '@/lib/billing/asaas'

interface Body {
  value?: unknown
  first_due_date?: unknown
  description?: unknown
  future_value?: unknown
  future_from?: unknown
}

function money(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null
  if (typeof v !== 'string') return null
  const n = Number(v.trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 'YYYY-MM-DD' — o formato que o Asaas espera no nextDueDate. */
function isoDay(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return null
  const d = new Date(`${v.trim()}T12:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : v.trim()
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    await requirePlatformAdmin()
    const { orgId } = await params
    const body = (await request.json().catch(() => ({}))) as Body

    const value = money(body.value)
    if (!value) {
      return NextResponse.json({ error: 'Valor inválido (ex.: 497 ou 1298,50).' }, { status: 400 })
    }
    const firstDueDate = isoDay(body.first_due_date)
    if (!firstDueDate) {
      return NextResponse.json(
        { error: 'Primeiro vencimento inválido (use AAAA-MM-DD).' },
        { status: 400 },
      )
    }

    const billing = firstOrNull(
      await db
        .select()
        .from(organizationBilling)
        .where(eq(organizationBilling.organizationId, orgId))
        .limit(1),
    )
    if (!billing) {
      return NextResponse.json({ error: 'Cliente sem cadastro de cobrança.' }, { status: 404 })
    }
    if (billing.asaasSubscriptionId) {
      return NextResponse.json(
        {
          error:
            'Esta conta já tem assinatura vinculada no Asaas. Desvincule antes de criar outra — cobrar duas vezes o mesmo cliente não tem desfazer.',
        },
        { status: 409 },
      )
    }

    // Quem vamos cobrar: o customer já vinculado, ou o que o documento achar.
    let customerId = billing.asaasCustomerId
    if (!customerId) {
      const doc = (billing.cpfCnpj ?? '').replace(/\D/g, '')
      if (!doc) {
        return NextResponse.json(
          { error: 'Preencha o CPF/CNPJ do cliente (ou vincule o cadastro do Asaas) antes.' },
          { status: 400 },
        )
      }
      customerId = await findCustomerByCpfCnpj(doc)
      if (!customerId) {
        return NextResponse.json(
          {
            error:
              'Não achei esse CPF/CNPJ no Asaas. Cadastre o cliente lá primeiro — daqui a gente não cria cadastro no escuro.',
          },
          { status: 404 },
        )
      }
    }

    const description =
      typeof body.description === 'string' && body.description.trim()
        ? body.description.trim()
        : `FluxiaCRM — ${billing.plan ?? 'assinatura'}`

    let subscriptionId: string
    try {
      const sub = await createSubscription({
        customer: customerId,
        value,
        nextDueDate: firstDueDate,
        description,
        externalReference: orgId,
      })
      subscriptionId = sub.id
    } catch (err) {
      const msg = err instanceof AsaasError ? err.message : 'Falha ao criar a assinatura no Asaas.'
      console.error('[admin/subscription] criar falhou:', err)
      return NextResponse.json({ error: msg }, { status: 502 })
    }

    // Degrau de preço combinado: o Asaas não agenda troca de valor, então
    // fica escrito na conta pra alguém lembrar de subir na data.
    const futureValue = money(body.future_value)
    const futureFrom = isoDay(body.future_from)
    const degrau =
      futureValue && futureFrom
        ? `A partir de ${futureFrom.split('-').reverse().join('/')}: R$ ${futureValue
            .toFixed(2)
            .replace('.', ',')} (subir o valor da assinatura no Asaas nessa data).`
        : null
    const notes = [billing.notes?.trim(), degrau].filter(Boolean).join('\n') || null

    await db
      .update(organizationBilling)
      .set({
        asaasCustomerId: customerId,
        asaasSubscriptionId: subscriptionId,
        monthlyValue: value.toFixed(2),
        dueAt: new Date(`${firstDueDate}T12:00:00Z`).toISOString(),
        notes,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(organizationBilling.organizationId, orgId))

    console.log(
      `[admin/subscription] assinatura ${subscriptionId} criada para ${orgId}: R$ ${value} a partir de ${firstDueDate}`,
    )
    return NextResponse.json({ ok: true, subscriptionId, customerId, value, firstDueDate })
  } catch (err) {
    return toErrorResponse(err)
  }
}
