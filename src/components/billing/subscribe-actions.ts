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
 * Dados de cobrança coletados no próprio checkout (28/09).
 *
 * Pedido do Alex: "os clientes que for assinando através de anúncio, ou alguém
 * que recebeu o link e assinou lá depois do teste, também preenche esses campos
 * na hora da assinatura." Antes, quem assinava sozinho entrava no CRM com
 * documento e mais nada — e o endereço teria de ser caçado um a um quando a
 * nota fiscal entrasse.
 *
 * TUDO opcional, e de propósito: isto é a tela onde o cliente paga. Exigir CEP
 * para deixar assinar troca uma nota fiscal mais fácil por uma venda perdida.
 * O que é obrigatório continua sendo só o documento, que o Asaas exige.
 */
export interface SubscribeDetails {
  billingEmail?: string
  postalCode?: string
  address?: string
  addressNumber?: string
  complement?: string
  /** BAIRRO — nome do campo no Asaas. */
  province?: string
  city?: string
  state?: string
}

/** Texto limpo ou undefined — string vazia no Asaas é pior que campo ausente. */
function limpo(v: string | undefined, max = 120): string | undefined {
  const t = (v ?? '').trim()
  return t ? t.slice(0, max) : undefined
}

/**
 * Inicia a assinatura de um plano. Retorna a URL de pagamento do Asaas pra o
 * cliente redirecionar. Lança Error com mensagem amigável (validar no cliente).
 */
export async function subscribeToPlan(
  planKey: string,
  cpfCnpjRaw: string,
  details: SubscribeDetails = {},
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

  // Endereço: normaliza o que vai virar registro (CEP só dígitos, UF em 2
  // maiúsculas) e deixa o resto como o cliente escreveu.
  const postalCode = limpo(details.postalCode)?.replace(/\D/g, '').slice(0, 8) || undefined
  const state =
    limpo(details.state)
      ?.toUpperCase()
      .replace(/[^A-Z]/g, '')
      .slice(0, 2) || undefined
  const billingEmail = limpo(details.billingEmail)?.toLowerCase()
  const endereco = {
    postalCode,
    address: limpo(details.address),
    addressNumber: limpo(details.addressNumber, 20),
    complement: limpo(details.complement, 60),
    province: limpo(details.province, 60),
  }

  try {
    const customer = await findOrCreateCustomer({
      name,
      email,
      cpfCnpj,
      externalReference: ctx.accountId,
      ...endereco,
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
        // Documento e valor também: quem assinava sozinho entrava sem eles, e o
        // painel de MRR ficava com um cliente pagante e valor em branco.
        cpfCnpj,
        monthlyValue: plan.price.toFixed(2),
        billingCycle: 'monthly',
        billingEmail,
        billingPostalCode: postalCode,
        billingAddress: endereco.address,
        billingAddressNumber: endereco.addressNumber,
        billingComplement: endereco.complement,
        billingProvince: endereco.province,
        billingCity: limpo(details.city, 60),
        billingState: state,
      })
      .onConflictDoUpdate({
        target: organizationBilling.organizationId,
        set: {
          plan: plan.name,
          asaasCustomerId: customer,
          asaasSubscriptionId: sub.id,
          cpfCnpj,
          monthlyValue: plan.price.toFixed(2),
          billingCycle: 'monthly',
          // ⚠️ Campo vazio no checkout NÃO apaga o que já está no cadastro: o
          // cliente pode estar reassinando, e o Alex já ter preenchido o
          // endereço à mão no /admin. `undefined` no Drizzle não entra no SET.
          billingEmail: billingEmail ?? undefined,
          billingPostalCode: postalCode ?? undefined,
          billingAddress: endereco.address ?? undefined,
          billingAddressNumber: endereco.addressNumber ?? undefined,
          billingComplement: endereco.complement ?? undefined,
          billingProvince: endereco.province ?? undefined,
          billingCity: limpo(details.city, 60) ?? undefined,
          billingState: state ?? undefined,
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
