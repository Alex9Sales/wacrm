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
// 28/09 — DOIS REGIMES, porque contrato longo não é mensalidade repetida:
//   • mensal      → assinatura no Asaas (/subscriptions), repete todo mês;
//   • semestral   → UMA cobrança de 6 × o valor mensal;
//   • anual       → UMA cobrança de 12 × o valor mensal.
// Regra do Alex: "assinatura semestral é sempre o valor total dos 6 meses; ele
// parcela no cartão dele, mas nós recebemos o valor integral. Mesma coisa seria
// se fosse anual." O parcelamento é entre o cliente e o cartão dele — daqui sai
// uma cobrança só, e o `billingType: UNDEFINED` deixa ele escolher como paga.
//
// ⚠️ `value` no body é SEMPRE o valor POR MÊS, nos três regimes. O total é
// derivado aqui (mês × meses). É a regra de ouro do lib/billing/cycle.ts: o MRR
// é mensal por definição, e gravar o total do semestre como valor faria a
// receita recorrente do painel inchar seis vezes.
//
// Body: { value, first_due_date, cycle?, description?, future_value?, future_from? }
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
import {
  AsaasError,
  createPayment,
  createSubscription,
  findCustomerByCpfCnpj,
} from '@/lib/billing/asaas'
// chargeForCycle é a ÚNICA fonte do total — a mesma que a tela usa para mostrar
// o número antes do clique. Não é contractTotal: aquele aplica o desconto de
// tabela (−20% semestral), e o que chega aqui já é o valor negociado.
import { CYCLES, chargeForCycle, parseBillingCycle } from '@/lib/billing/cycle'

interface Body {
  value?: unknown
  first_due_date?: unknown
  cycle?: unknown
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
    if (billing.asaasSubscriptionId || billing.asaasPaymentId) {
      return NextResponse.json(
        {
          error: billing.asaasSubscriptionId
            ? 'Esta conta já tem assinatura vinculada no Asaas. Desvincule antes de criar outra — cobrar duas vezes o mesmo cliente não tem desfazer.'
            : 'Esta conta já tem uma cobrança emitida no Asaas. Desvincule antes de criar outra — cobrar duas vezes o mesmo cliente não tem desfazer.',
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

    // Ciclo ausente = mensal: é o que o endpoint sempre fez, e o que a tela
    // manda quando ninguém escolheu nada. Aqui assumir mensal é seguro — cobra
    // UM mês; assumir semestral cobraria seis.
    const cycle = parseBillingCycle(body.cycle) ?? 'monthly'
    const { months: meses, total, oneOff } = chargeForCycle(value, cycle)

    let subscriptionId: string | null = null
    let paymentId: string | null = null
    try {
      if (!oneOff) {
        const sub = await createSubscription({
          customer: customerId,
          value,
          nextDueDate: firstDueDate,
          description,
          externalReference: orgId,
        })
        subscriptionId = sub.id
      } else {
        const pay = await createPayment({
          customer: customerId,
          value: total,
          dueDate: firstDueDate,
          description: `${description} — ${CYCLES[cycle].label.toLowerCase()} (${meses} meses)`,
          externalReference: orgId,
        })
        paymentId = pay.id
      }
    } catch (err) {
      const msg = err instanceof AsaasError ? err.message : 'Falha ao criar a cobrança no Asaas.'
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
        asaasPaymentId: paymentId,
        billingCycle: cycle,
        // POR MÊS mesmo num semestral — o total foi cobrado, mas o MRR é mensal.
        monthlyValue: value.toFixed(2),
        dueAt: new Date(`${firstDueDate}T12:00:00Z`).toISOString(),
        notes,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(organizationBilling.organizationId, orgId))

    console.log(
      `[admin/subscription] ${
        subscriptionId ? `assinatura ${subscriptionId}` : `cobrança ${paymentId}`
      } criada para ${orgId}: R$ ${total} (${CYCLES[cycle].label.toLowerCase()}, R$ ${value}/mês) com vencimento ${firstDueDate}`,
    )
    return NextResponse.json({
      ok: true,
      subscriptionId,
      paymentId,
      customerId,
      cycle,
      value,
      total,
      firstDueDate,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
