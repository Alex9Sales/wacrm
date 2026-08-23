import { and, asc, eq } from 'drizzle-orm'

import {
  db,
  dealProposals,
  deals,
  dealProducts,
  contacts,
  companies,
  organization,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCompanyProfile } from '@/lib/ai/company-profile'
import {
  computeTotals,
  proposalNumber,
  DEFAULT_PROPOSAL_FIELDS,
  type ProposalItem,
  type ProposalSeller,
  type ProposalClient,
  type ProposalFields,
  type ProposalData,
  type ProposalSellerOverride,
  type DiscountType,
} from '@/lib/proposals/shared'

// ============================================================
// Proposta do negócio — camada de dados (DB). Reúne marca do vendedor +
// dados do cliente + itens + totais num único objeto, usado (a) pela aba
// Propostas do negócio e (b) pela PÁGINA PÚBLICA /proposta/<id>. A página
// pública NÃO tem contexto de conta — o loader público resolve tudo a
// partir do id (token) da proposta. Tipos/cálculos puros vêm de ./shared.
// ============================================================

export type { ProposalData, ProposalFields, DiscountType } from '@/lib/proposals/shared'

/**
 * Monta o objeto completo da proposta a partir do negócio + campos salvos.
 * Compartilhado pela action autenticada e pelo loader público. Não faz
 * checagem de acesso — o chamador é quem valida (a action por conta; o
 * público pela posse do token/id).
 */
export async function buildProposalData(
  accountId: string,
  dealId: string,
  fields: ProposalFields,
  proposalId: string | null,
  createdAt: string | null,
  sellerOverride?: ProposalSellerOverride | null,
): Promise<ProposalData | null> {
  const deal = firstOrNull(
    await db
      .select({
        title: deals.title,
        currency: deals.currency,
        contactId: deals.contactId,
        companyId: deals.companyId,
      })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.accountId, accountId)))
      .limit(1),
  )
  if (!deal) return null

  const [org, profile, prodRows] = await Promise.all([
    firstOrNull(
      await db
        .select({
          name: organization.name,
          logo: organization.logo,
          currency: organization.default_currency,
        })
        .from(organization)
        .where(eq(organization.id, accountId))
        .limit(1),
    ),
    getCompanyProfile(accountId),
    db
      .select({
        name: dealProducts.name,
        quantity: dealProducts.quantity,
        unitPrice: dealProducts.unitPrice,
      })
      .from(dealProducts)
      .where(eq(dealProducts.dealId, dealId))
      .orderBy(asc(dealProducts.createdAt)),
  ])

  const contact = deal.contactId
    ? firstOrNull(
        await db
          .select({ name: contacts.name, email: contacts.email, phone: contacts.phone })
          .from(contacts)
          .where(eq(contacts.id, deal.contactId))
          .limit(1),
      )
    : null

  const company = deal.companyId
    ? firstOrNull(
        await db
          .select({
            name: companies.name,
            document: companies.document,
            email: companies.email,
            phone: companies.phone,
            address: companies.address,
          })
          .from(companies)
          .where(eq(companies.id, deal.companyId))
          .limit(1),
      )
    : null

  const items: ProposalItem[] = prodRows.map((p) => {
    const quantity = Number(p.quantity) || 0
    const unitPrice = Number(p.unitPrice) || 0
    return { name: p.name, quantity, unitPrice, subtotal: quantity * unitPrice }
  })

  const seller: ProposalSeller = {
    // Nome fantasia > razão social > nome comercial (AI) > nome da conta.
    name: (
      profile.trade_name ||
      profile.business_name ||
      profile.legal_name ||
      org?.name ||
      'Proposta comercial'
    ).trim(),
    logo: org?.logo ?? null,
    tagline: profile.description?.trim() || null,
    paymentMethods: profile.payment_methods?.trim() || null,
    document: profile.document?.trim() || null,
    website: profile.website?.trim() || null,
    address: profile.address?.trim() || null,
    phone: profile.phone?.trim() || null,
  }
  // Override por proposta (Seção Propostas): campo preenchido substitui o perfil.
  if (sellerOverride) {
    const o = sellerOverride
    if (o.name && o.name.trim()) seller.name = o.name.trim()
    if (o.logo && o.logo.trim()) seller.logo = o.logo.trim()
    if (o.tagline && o.tagline.trim()) seller.tagline = o.tagline.trim()
    if (o.paymentMethods && o.paymentMethods.trim())
      seller.paymentMethods = o.paymentMethods.trim()
  }

  // Cliente: prioriza a empresa (razão social/CNPJ), completa com o contato.
  const client: ProposalClient = {
    name: company?.name || contact?.name || null,
    document: company?.document || null,
    email: company?.email || contact?.email || null,
    phone: company?.phone || contact?.phone || null,
    address: company?.address || null,
  }

  return {
    id: proposalId,
    dealTitle: deal.title,
    currency: deal.currency || org?.currency || 'BRL',
    number: proposalNumber(proposalId || dealId),
    seller,
    client,
    items,
    fields,
    totals: computeTotals(items, fields.discount, fields.discountType),
    createdAt,
  }
}

/** Lê a linha deal_proposals de um negócio (ou defaults se ainda não existe). */
export interface ProposalTracking {
  viewedAt: string | null
  acceptedAt: string | null
  acceptorName: string | null
  acceptorDocument: string | null
}

export async function loadDealProposalFields(
  accountId: string,
  dealId: string,
): Promise<{
  id: string | null
  createdAt: string | null
  fields: ProposalFields
  tracking: ProposalTracking
  sellerOverride: ProposalSellerOverride | null
}> {
  const row = firstOrNull(
    await db
      .select({
        id: dealProposals.id,
        discount: dealProposals.discount,
        discountType: dealProposals.discountType,
        validUntil: dealProposals.validUntil,
        terms: dealProposals.terms,
        createdAt: dealProposals.createdAt,
        sellerOverride: dealProposals.sellerOverride,
        viewedAt: dealProposals.viewedAt,
        acceptedAt: dealProposals.acceptedAt,
        acceptorName: dealProposals.acceptorName,
        acceptorDocument: dealProposals.acceptorDocument,
      })
      .from(dealProposals)
      .where(
        and(eq(dealProposals.dealId, dealId), eq(dealProposals.accountId, accountId)),
      )
      .limit(1),
  )
  const emptyTracking: ProposalTracking = {
    viewedAt: null,
    acceptedAt: null,
    acceptorName: null,
    acceptorDocument: null,
  }
  if (!row) {
    return {
      id: null,
      createdAt: null,
      fields: { ...DEFAULT_PROPOSAL_FIELDS },
      tracking: emptyTracking,
      sellerOverride: null,
    }
  }
  return {
    id: row.id,
    createdAt: row.createdAt,
    fields: {
      discount: Number(row.discount) || 0,
      discountType: (row.discountType as DiscountType) || 'value',
      validUntil: row.validUntil ?? null,
      terms: row.terms ?? null,
    },
    tracking: {
      viewedAt: row.viewedAt ?? null,
      acceptedAt: row.acceptedAt ?? null,
      acceptorName: row.acceptorName ?? null,
      acceptorDocument: row.acceptorDocument ?? null,
    },
    sellerOverride: (row.sellerOverride as ProposalSellerOverride | null) ?? null,
  }
}

/**
 * Loader PÚBLICO (sem auth): resolve a proposta pelo id (token) e monta os
 * dados. Retorna null se o id não existe. O id é um uuid não-adivinhável, que
 * é a chave do link compartilhável.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function getPublicProposalData(
  proposalId: string,
): Promise<ProposalData | null> {
  // Link malformado (id não-uuid) → não existe (evita erro de cast do Postgres).
  if (!UUID_RE.test(proposalId)) return null
  try {
  const row = firstOrNull(
    await db
      .select({
        id: dealProposals.id,
        accountId: dealProposals.accountId,
        dealId: dealProposals.dealId,
        discount: dealProposals.discount,
        discountType: dealProposals.discountType,
        validUntil: dealProposals.validUntil,
        terms: dealProposals.terms,
        createdAt: dealProposals.createdAt,
        sellerOverride: dealProposals.sellerOverride,
        acceptedAt: dealProposals.acceptedAt,
        acceptorName: dealProposals.acceptorName,
      })
      .from(dealProposals)
      .where(eq(dealProposals.id, proposalId))
      .limit(1),
  )
  if (!row) return null
  const fields: ProposalFields = {
    discount: Number(row.discount) || 0,
    discountType: (row.discountType as DiscountType) || 'value',
    validUntil: row.validUntil ?? null,
    terms: row.terms ?? null,
  }
  const data = await buildProposalData(
    row.accountId,
    row.dealId,
    fields,
    row.id,
    row.createdAt,
    (row.sellerOverride as ProposalSellerOverride | null) ?? null,
  )
  if (!data) return null
  data.accepted = row.acceptedAt
    ? { at: row.acceptedAt, name: row.acceptorName ?? '' }
    : null
  return data
  } catch (err) {
    console.error('[getPublicProposalData]', err)
    return null
  }
}
