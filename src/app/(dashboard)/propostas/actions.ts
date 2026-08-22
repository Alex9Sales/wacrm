'use server'

import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'

import {
  db,
  dealProposals,
  deals,
  dealProducts,
  contacts,
  companies,
  pipelines,
  pipelineStages,
} from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import { ingestLead } from '@/lib/leads/ingest'
import {
  computeTotals,
  type DiscountType,
  type ProposalSellerOverride,
} from '@/lib/proposals/shared'

const APP_URL = (
  process.env.APP_URL || 'https://crm.salestecnologia.com.br'
).replace(/\/$/, '')

function publicUrl(proposalId: string): string {
  return `${APP_URL}/proposta/${proposalId}`
}

// ------------------------------------------------------------
// Lista da seção Propostas.
// ------------------------------------------------------------
export interface ProposalListRow {
  id: string
  dealId: string
  dealTitle: string
  clientName: string | null
  companyName: string | null
  value: number
  currency: string
  status: 'criada' | 'vista' | 'aceita'
  createdAt: string
  publicUrl: string
}

export async function listAllProposals(): Promise<ProposalListRow[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: dealProposals.id,
      dealId: dealProposals.dealId,
      createdAt: dealProposals.createdAt,
      viewedAt: dealProposals.viewedAt,
      acceptedAt: dealProposals.acceptedAt,
      dealTitle: deals.title,
      dealValue: deals.value,
      currency: deals.currency,
      contactName: contacts.name,
      companyName: companies.name,
    })
    .from(dealProposals)
    .innerJoin(deals, eq(deals.id, dealProposals.dealId))
    .leftJoin(contacts, eq(contacts.id, deals.contactId))
    .leftJoin(companies, eq(companies.id, deals.companyId))
    .where(eq(dealProposals.accountId, ctx.accountId))
    .orderBy(desc(dealProposals.createdAt))
  return rows.map((r) => ({
    id: r.id,
    dealId: r.dealId,
    dealTitle: r.dealTitle,
    clientName: r.companyName || r.contactName || null,
    companyName: r.companyName ?? null,
    value: Number(r.dealValue) || 0,
    currency: r.currency || 'BRL',
    status: r.acceptedAt ? 'aceita' : r.viewedAt ? 'vista' : 'criada',
    createdAt: r.createdAt,
    publicUrl: publicUrl(r.id),
  }))
}

/** Funis + etapas pro seletor de destino (quando cria um lead novo). */
export async function listProposalPipelines(): Promise<
  { id: string; name: string; stages: { id: string; name: string }[] }[]
> {
  const ctx = await getCurrentAccount()
  const [pips, stgs] = await Promise.all([
    db
      .select({ id: pipelines.id, name: pipelines.name })
      .from(pipelines)
      .where(eq(pipelines.accountId, ctx.accountId))
      .orderBy(pipelines.name),
    db
      .select({
        id: pipelineStages.id,
        name: pipelineStages.name,
        pipelineId: pipelineStages.pipelineId,
      })
      .from(pipelineStages)
      .innerJoin(pipelines, eq(pipelines.id, pipelineStages.pipelineId))
      .where(eq(pipelines.accountId, ctx.accountId))
      .orderBy(pipelineStages.position),
  ])
  return pips.map((p) => ({
    id: p.id,
    name: p.name,
    stages: stgs
      .filter((s) => s.pipelineId === p.id)
      .map((s) => ({ id: s.id, name: s.name })),
  }))
}

/** Busca negócios abertos p/ anexar a proposta (por título/contato). */
export async function searchLeadsForProposal(
  query: string,
): Promise<{ id: string; label: string }[]> {
  const ctx = await getCurrentAccount()
  const q = (query ?? '').trim()
  if (q.length < 2) return []
  const like = `%${q}%`
  const rows = await db
    .select({
      id: deals.id,
      title: deals.title,
      contactName: contacts.name,
      contactPhone: contacts.phone,
    })
    .from(deals)
    .leftJoin(contacts, eq(contacts.id, deals.contactId))
    .where(
      and(
        eq(deals.accountId, ctx.accountId),
        or(
          ilike(deals.title, like),
          ilike(contacts.name, like),
          ilike(contacts.phone, like),
        ),
      ),
    )
    .orderBy(desc(deals.createdAt))
    .limit(10)
  return rows.map((r) => ({
    id: r.id,
    label: [r.title, r.contactName, r.contactPhone].filter(Boolean).join(' · '),
  }))
}

// ------------------------------------------------------------
// Criar / atualizar proposta (a orquestração da seção).
// ------------------------------------------------------------
export interface ProposalItemInput {
  name: string
  quantity: number
  unitPrice: number
}

export interface SaveProposalDraftInput {
  proposalId?: string | null
  mode: 'new' | 'existing'
  dealId?: string | null
  clientName?: string | null
  clientCompany?: string | null
  clientDocument?: string | null
  clientPhone?: string | null
  clientEmail?: string | null
  pipelineId?: string | null
  stageId?: string | null
  title?: string | null
  items: ProposalItemInput[]
  discount: number
  discountType: DiscountType
  validUntil: string | null
  terms: string | null
  sellerOverride: ProposalSellerOverride | null
}

function cleanItems(items: ProposalItemInput[]): ProposalItemInput[] {
  return (items ?? [])
    .map((it) => ({
      name: (it.name ?? '').trim(),
      quantity: Number.isFinite(it.quantity) ? Math.max(0, it.quantity) : 1,
      unitPrice: Number.isFinite(it.unitPrice) ? Math.max(0, it.unitPrice) : 0,
    }))
    .filter((it) => it.name.length > 0)
}

function cleanOverride(
  o: ProposalSellerOverride | null,
): ProposalSellerOverride | null {
  if (!o) return null
  const out: ProposalSellerOverride = {
    name: (o.name ?? '').trim() || null,
    logo: (o.logo ?? '').trim() || null,
    tagline: (o.tagline ?? '').trim() || null,
    paymentMethods: (o.paymentMethods ?? '').trim() || null,
  }
  // Só guarda se tem ALGUM campo preenchido; senão null (usa o perfil).
  return out.name || out.logo || out.tagline || out.paymentMethods ? out : null
}

/** Resolve a empresa (por nome, único por conta) + grava o CNPJ e liga ao negócio. */
async function attachCompany(
  accountId: string,
  dealId: string,
  contactId: string | null,
  companyName: string,
  document: string | null,
) {
  const name = companyName.trim()
  if (!name) return
  const existing = firstOrNull(
    await db
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.accountId, accountId), sql`lower(${companies.name}) = lower(${name})`))
      .limit(1),
  )
  let companyId: string
  if (existing) {
    companyId = existing.id
    if (document) {
      await db
        .update(companies)
        .set({ document })
        .where(eq(companies.id, companyId))
    }
  } else {
    const created = firstOrThrow(
      await db
        .insert(companies)
        .values({ accountId, name, document: document || null })
        .returning({ id: companies.id }),
    )
    companyId = created.id
  }
  await db
    .update(deals)
    .set({ companyId })
    .where(and(eq(deals.id, dealId), eq(deals.accountId, accountId)))
  if (contactId) {
    await db
      .update(contacts)
      .set({ companyId })
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
  }
}

export async function saveProposalDraft(
  input: SaveProposalDraftInput,
): Promise<{ id: string | null; dealId: string | null; publicUrl: string | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const items = cleanItems(input.items)
    const total = computeTotals(
      items.map((it) => ({
        name: it.name,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        subtotal: it.quantity * it.unitPrice,
      })),
      input.discount,
      input.discountType,
    ).total

    let dealId = input.dealId ?? null
    let contactId: string | null = null

    if (input.mode === 'new') {
      const phone = (input.clientPhone ?? '').trim()
      if (!phone) {
        return {
          id: null,
          dealId: null,
          publicUrl: null,
          error: 'Informe o WhatsApp do cliente (ou anexe a proposta a um lead existente).',
        }
      }
      const res = await ingestLead(ctx.accountId, ctx.userId, {
        rawPhone: phone,
        name: input.clientName || null,
        email: input.clientEmail || null,
        company: input.clientCompany || null,
        pipelineId: input.pipelineId || null,
        stageId: input.stageId || null,
        origin: 'Proposta',
        fallbackNote: 'Lead criado ao gerar uma proposta.',
      })
      dealId = res.dealId
      contactId = res.contactId
      if (!dealId) {
        return { id: null, dealId: null, publicUrl: null, error: 'Falha ao criar o negócio.' }
      }
      const dealTitle =
        (input.title ?? '').trim() ||
        (input.clientCompany ?? '').trim() ||
        (input.clientName ?? '').trim() ||
        'Proposta'
      await db
        .update(deals)
        .set({ title: dealTitle, value: String(total) })
        .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
      if ((input.clientCompany ?? '').trim()) {
        await attachCompany(
          ctx.accountId,
          dealId,
          contactId,
          input.clientCompany!.trim(),
          (input.clientDocument ?? '').trim() || null,
        )
      }
    } else {
      if (!dealId) {
        return { id: null, dealId: null, publicUrl: null, error: 'Escolha um negócio.' }
      }
      const owned = firstOrNull(
        await db
          .select({ id: deals.id })
          .from(deals)
          .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
          .limit(1),
      )
      if (!owned) {
        return { id: null, dealId: null, publicUrl: null, error: 'Negócio não encontrado.' }
      }
    }

    // Itens = produtos do negócio: substitui pelos do formulário.
    await db.delete(dealProducts).where(eq(dealProducts.dealId, dealId!))
    if (items.length > 0) {
      await db.insert(dealProducts).values(
        items.map((it) => ({
          accountId: ctx.accountId,
          dealId: dealId!,
          name: it.name,
          quantity: String(it.quantity > 0 ? it.quantity : 1),
          unitPrice: String(it.unitPrice),
        })),
      )
    }

    // Upsert da proposta (1 por negócio) + override de marca.
    const discount = Number.isFinite(input.discount) ? Math.max(0, input.discount) : 0
    const discountType: DiscountType =
      input.discountType === 'percent' ? 'percent' : 'value'
    const validUntil =
      input.validUntil && /^\d{4}-\d{2}-\d{2}$/.test(input.validUntil)
        ? input.validUntil
        : null
    const terms = (input.terms ?? '').trim() || null
    const sellerOverride = cleanOverride(input.sellerOverride)

    const row = firstOrThrow(
      await db
        .insert(dealProposals)
        .values({
          accountId: ctx.accountId,
          dealId: dealId!,
          discount: String(discount),
          discountType,
          validUntil,
          terms,
          sellerOverride,
          createdBy: ctx.userId,
          updatedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: dealProposals.dealId,
          set: {
            discount: String(discount),
            discountType,
            validUntil,
            terms,
            sellerOverride,
            updatedAt: sql`now()`,
          },
        })
        .returning({ id: dealProposals.id }),
    )

    return { id: row.id, dealId, publicUrl: publicUrl(row.id), error: null }
  } catch (err) {
    console.error('[saveProposalDraft]', err)
    return { id: null, dealId: null, publicUrl: null, error: 'Falha ao salvar a proposta.' }
  }
}

export async function deleteProposal(
  proposalId: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .delete(dealProposals)
      .where(and(eq(dealProposals.id, proposalId), eq(dealProposals.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    console.error('[deleteProposal]', err)
    return { error: 'Falha ao excluir a proposta.' }
  }
}
