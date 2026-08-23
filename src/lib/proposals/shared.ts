// ============================================================
// Proposta — tipos + cálculos + formatação PUROS (sem DB, sem server-only).
// Compartilhado entre o loader do servidor (proposal.ts), a aba Propostas
// no cliente (preview ao vivo) e a página pública. Nada aqui toca o banco.
// ============================================================

export type DiscountType = 'value' | 'percent'

export interface ProposalItem {
  name: string
  quantity: number
  unitPrice: number
  subtotal: number
}

export interface ProposalTotals {
  subtotal: number
  discountValue: number
  total: number
}

export interface ProposalSeller {
  name: string
  logo: string | null
  tagline: string | null
  paymentMethods: string | null
  document: string | null
  website: string | null
  address: string | null
}

export interface ProposalClient {
  name: string | null
  document: string | null
  email: string | null
  phone: string | null
  address: string | null
}

export interface ProposalFields {
  discount: number
  discountType: DiscountType
  validUntil: string | null // 'YYYY-MM-DD'
  terms: string | null
}

/** Override de marca por proposta (Seção Propostas). Campos vazios caem no
 *  perfil da conta. */
export interface ProposalSellerOverride {
  name?: string | null
  logo?: string | null
  tagline?: string | null
  paymentMethods?: string | null
}

export interface ProposalData {
  /** id da linha deal_proposals = token do link público (null se ainda não salvo) */
  id: string | null
  dealTitle: string
  currency: string
  number: string
  seller: ProposalSeller
  client: ProposalClient
  items: ProposalItem[]
  fields: ProposalFields
  totals: ProposalTotals
  createdAt: string | null
  /** Aceite digital (público): preenchido quando o cliente aceitou a proposta. */
  accepted?: { at: string; name: string } | null
}

export const DEFAULT_PROPOSAL_FIELDS: ProposalFields = {
  discount: 0,
  discountType: 'value',
  validUntil: null,
  terms: null,
}

/** subtotal − desconto (valor OU %), nunca abaixo de zero. */
export function computeTotals(
  items: ProposalItem[],
  discount: number,
  discountType: DiscountType,
): ProposalTotals {
  const subtotal = items.reduce((sum, it) => sum + it.subtotal, 0)
  const raw =
    discountType === 'percent' ? (subtotal * (discount || 0)) / 100 : discount || 0
  const discountValue = Math.max(0, Math.min(raw, subtotal))
  return { subtotal, discountValue, total: Math.max(0, subtotal - discountValue) }
}

/** Número humano curto e estável da proposta (deriva do id/deal). */
export function proposalNumber(seed: string): string {
  return seed.replace(/-/g, '').slice(0, 8).toUpperCase()
}

export function formatProposalMoney(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(n)
  } catch {
    return `${currency} ${(n || 0).toFixed(2)}`
  }
}

/** 'YYYY-MM-DD' → 'DD/MM/YYYY' (sem shift de fuso). */
export function formatProposalDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (m) return `${m[3]}/${m[2]}/${m[1]}`
  return iso
}
