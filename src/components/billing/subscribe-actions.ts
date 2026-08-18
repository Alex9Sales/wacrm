'use server'

// ============================================================
// Assinatura do FluxiaCRM via Asaas. Roda no fluxo de checkout — por isso usa
// getBillingContext (SEM o gate de trial/suspensão): é justamente quando o
// trial venceu que o cliente precisa assinar. Só dono/admin assina.
// Cria/acha o customer no Asaas + a assinatura mensal, grava os ids no billing e
// devolve a URL de pagamento (o cliente escolhe Pix/boleto/cartão na tela do
// Asaas). O status só vira 'active' quando o webhook confirma o pagamento.
// ============================================================

import { headers } from 'next/headers'
import { eq } from 'drizzle-orm'

import { db, organizationBilling } from '@/db'
import { auth } from '@/lib/auth'
import { getBillingContext } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { getPlan } from '@/lib/billing/plans'
import {
  asaasConfigured,
  findOrCreateCustomer,
  createSubscription,
  firstInvoiceUrl,
  AsaasError,
} from '@/lib/billing/asaas'

export interface SubscribeResult {
  url: string
}

/**
 * Inicia a assinatura de um plano. Retorna a URL de pagamento do Asaas pra o
 * cliente redirecionar. Lança Error com mensagem amigável (validar no cliente).
 */
export async function subscribeToPlan(
  planKey: string,
  cpfCnpjRaw: string,
): Promise<SubscribeResult> {
  const ctx = await getBillingContext()
  if (!hasMinRole(ctx.role, 'admin')) {
    throw new Error('Só o dono ou admin da conta pode assinar.')
  }

  const plan = getPlan(planKey)
  if (!plan) throw new Error('Plano inválido.')

  const cpfCnpj = (cpfCnpjRaw || '').replace(/\D/g, '')
  if (cpfCnpj.length !== 11 && cpfCnpj.length !== 14) {
    throw new Error('Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido.')
  }

  if (!asaasConfigured()) {
    throw new Error('Pagamento indisponível no momento. Fale com a Fluxia.')
  }

  // Dados do responsável (nome/e-mail) vêm da sessão.
  const session = await auth.api
    .getSession({ headers: await headers() })
    .catch(() => null)
  const email = session?.user?.email
  const name = session?.user?.name || ctx.account.name
  if (!email) {
    throw new Error('Não encontrei seu e-mail. Recarregue a página e tente de novo.')
  }

  try {
    const customer = await findOrCreateCustomer({
      name,
      email,
      cpfCnpj,
      externalReference: ctx.accountId,
    })

    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const sub = await createSubscription({
      customer,
      value: plan.price,
      nextDueDate: today,
      description: `FluxiaCRM — Plano ${plan.name}`,
      externalReference: ctx.accountId,
    })

    // Grava no billing (a linha existe do trial; upsert por segurança).
    await db
      .insert(organizationBilling)
      .values({
        organizationId: ctx.accountId,
        status: 'trial',
        plan: plan.name,
        asaasCustomerId: customer,
        asaasSubscriptionId: sub.id,
      })
      .onConflictDoUpdate({
        target: organizationBilling.organizationId,
        set: {
          plan: plan.name,
          asaasCustomerId: customer,
          asaasSubscriptionId: sub.id,
          updatedAt: new Date().toISOString(),
        },
      })

    const url = await firstInvoiceUrl(sub.id)
    if (!url) {
      throw new Error(
        'Assinatura criada, mas não gerei o link de pagamento. Tente de novo.',
      )
    }
    return { url }
  } catch (err) {
    if (err instanceof AsaasError) {
      console.error('[billing/subscribe] Asaas error:', err.status, err.message)
      throw new Error(`Não consegui criar a cobrança: ${err.message}`)
    }
    throw err
  }
}
