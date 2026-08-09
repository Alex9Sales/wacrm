'use server'

// ============================================================
// Empresas como ENTIDADE — server actions (Fase 1).
// Account-scoped via getCurrentAccount / requireRole. Leituras trazem contagem
// de contatos e de negócios (negócio → contato → empresa, já que o vínculo
// direto negócio↔empresa é da Fase 2). Escritas exigem agent+.
// ============================================================

import { and, asc, eq, ilike, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { db, companies, contacts, deals, conversations } from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'

function clean(v: string | null | undefined): string | null {
  const t = (v ?? '').trim()
  return t ? t : null
}

export interface CompanyRow {
  id: string
  name: string
  segment: string | null
  website: string | null
  phone: string | null
  contacts_count: number
  deals_count: number
  created_at: string
}

export interface CompanyLite {
  id: string
  name: string
}

// Nº de contatos e de negócios (via contato) de uma empresa — subselects
// correlacionados. A referência ao id da empresa externa é QUALIFICADA
// (`"companies"."id"`) de propósito: sem a tabela, o "id" fica ambíguo dentro do
// subselect (contacts/deals também têm "id") → "column reference id is ambiguous".
const CONTACTS_COUNT = sql<number>`(SELECT count(*)::int FROM contacts cc WHERE cc.company_id = "companies"."id")`
// Empresas Fase 2: negócios contam pelo vínculo DIRETO (deals.company_id).
const DEALS_COUNT = sql<number>`(SELECT count(*)::int FROM deals dd WHERE dd.company_id = "companies"."id")`

/** Lista de empresas da conta (com contagens), filtrável por nome. */
export async function listCompanies(search?: string): Promise<CompanyRow[]> {
  const ctx = await getCurrentAccount()
  const term = (search ?? '').trim()
  const where = [eq(companies.accountId, ctx.accountId)]
  if (term) where.push(ilike(companies.name, `%${term}%`))
  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      segment: companies.segment,
      website: companies.website,
      phone: companies.phone,
      created_at: companies.createdAt,
      contacts_count: CONTACTS_COUNT,
      deals_count: DEALS_COUNT,
    })
    .from(companies)
    .where(and(...where))
    .orderBy(asc(companies.name))
  return rows.map((r) => ({
    ...r,
    created_at: r.created_at as string,
    contacts_count: Number(r.contacts_count ?? 0),
    deals_count: Number(r.deals_count ?? 0),
  }))
}

/** Opções leves para o seletor de empresa (contato/negócio). */
export async function listCompanyOptions(): Promise<CompanyLite[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.accountId, ctx.accountId))
    .orderBy(asc(companies.name))
  return rows as CompanyLite[]
}

export interface CompanyContact {
  id: string
  name: string | null
  phone: string
  email: string | null
  avatar_url: string | null
}

export interface CompanyDeal {
  id: string
  title: string
  value: number
  status: string
  contact_name: string | null
}

export interface CompanyDetail {
  id: string
  name: string
  segment: string | null
  website: string | null
  phone: string | null
  notes: string | null
  created_at: string
  contacts: CompanyContact[]
  deals: CompanyDeal[]
  open_deals_value: number
  last_contact_at: string | null
}

/** Detalhe de uma empresa: dados + contatos + negócios (via contato). */
export async function getCompany(id: string): Promise<CompanyDetail | null> {
  const ctx = await getCurrentAccount()
  const row = firstOrNull(
    await db
      .select({
        id: companies.id,
        name: companies.name,
        segment: companies.segment,
        website: companies.website,
        phone: companies.phone,
        notes: companies.notes,
        created_at: companies.createdAt,
      })
      .from(companies)
      .where(and(eq(companies.id, id), eq(companies.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!row) return null

  const companyContacts = await db
    .select({
      id: contacts.id,
      name: contacts.name,
      phone: contacts.phone,
      email: contacts.email,
      avatar_url: contacts.avatarUrl,
    })
    .from(contacts)
    .where(and(eq(contacts.companyId, id), eq(contacts.accountId, ctx.accountId)))
    .orderBy(asc(contacts.name))

  const companyDeals = await db
    .select({
      id: deals.id,
      title: deals.title,
      value: deals.value,
      status: deals.status,
      contact_name: contacts.name,
    })
    .from(deals)
    .leftJoin(contacts, eq(deals.contactId, contacts.id))
    // Vínculo DIRETO do negócio com a empresa (Fase 2).
    .where(and(eq(deals.companyId, id), eq(deals.accountId, ctx.accountId)))
    .orderBy(asc(deals.title))

  const deemedDeals: CompanyDeal[] = companyDeals.map((d) => ({
    id: d.id,
    title: d.title,
    value: Number(d.value ?? 0),
    status: d.status as string,
    contact_name: d.contact_name ?? null,
  }))
  const openValue = deemedDeals
    .filter((d) => d.status === 'open')
    .reduce((s, d) => s + d.value, 0)

  // Último contato: mensagem mais recente entre as conversas dos contatos desta
  // empresa.
  const lastRow = firstOrNull(
    await db
      .select({
        last: sql<string | null>`max(${conversations.lastMessageAt})`,
      })
      .from(conversations)
      .innerJoin(contacts, eq(conversations.contactId, contacts.id))
      .where(
        and(
          eq(contacts.companyId, id),
          eq(conversations.accountId, ctx.accountId),
        ),
      ),
  )

  return {
    id: row.id,
    name: row.name,
    segment: row.segment,
    website: row.website,
    phone: row.phone,
    notes: row.notes,
    created_at: row.created_at as string,
    contacts: companyContacts.map((c) => ({
      id: c.id,
      name: c.name ?? null,
      phone: c.phone,
      email: c.email ?? null,
      avatar_url: c.avatar_url ?? null,
    })),
    deals: deemedDeals,
    open_deals_value: openValue,
    last_contact_at: (lastRow?.last as string | null) ?? null,
  }
}

export interface CompanyInput {
  name: string
  segment?: string | null
  website?: string | null
  phone?: string | null
  notes?: string | null
}

/** Cria uma empresa. Erra se já existir uma com o mesmo nome (case-insensitive). */
export async function createCompany(
  input: CompanyInput,
): Promise<{ ok: true; company: CompanyLite } | { ok: false; error: string }> {
  try {
    const ctx = await requireRole('agent')
    const name = clean(input.name)
    if (!name) return { ok: false, error: 'O nome da empresa é obrigatório.' }
    const existing = firstOrNull(
      await db
        .select({ id: companies.id })
        .from(companies)
        .where(
          and(
            eq(companies.accountId, ctx.accountId),
            sql`lower(${companies.name}) = lower(${name})`,
          ),
        )
        .limit(1),
    )
    if (existing) return { ok: false, error: 'Já existe uma empresa com esse nome.' }
    const inserted = firstOrThrow(
      await db
        .insert(companies)
        .values({
          accountId: ctx.accountId,
          name,
          segment: clean(input.segment),
          website: clean(input.website),
          phone: clean(input.phone),
          notes: clean(input.notes),
          createdBy: ctx.userId,
        })
        .returning({ id: companies.id, name: companies.name }),
    )
    revalidatePath('/empresas')
    return { ok: true, company: inserted as CompanyLite }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Falha ao criar empresa.' }
  }
}

/**
 * Acha (case-insensitive) ou cria uma empresa pelo nome — usado pelo seletor de
 * empresa no contato ("digite e crie"). Não erra em duplicado: reusa a existente.
 */
export async function findOrCreateCompanyByName(
  rawName: string,
): Promise<{ ok: true; company: CompanyLite } | { ok: false; error: string }> {
  try {
    const ctx = await requireRole('agent')
    const name = clean(rawName)
    if (!name) return { ok: false, error: 'Informe o nome da empresa.' }
    const existing = firstOrNull(
      await db
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(
          and(
            eq(companies.accountId, ctx.accountId),
            sql`lower(${companies.name}) = lower(${name})`,
          ),
        )
        .limit(1),
    )
    if (existing) return { ok: true, company: existing as CompanyLite }
    const inserted = firstOrThrow(
      await db
        .insert(companies)
        .values({ accountId: ctx.accountId, name, createdBy: ctx.userId })
        .returning({ id: companies.id, name: companies.name }),
    )
    revalidatePath('/empresas')
    return { ok: true, company: inserted as CompanyLite }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Falha ao criar empresa.' }
  }
}

/** Edita os campos de uma empresa. */
export async function updateCompany(
  id: string,
  patch: Partial<CompanyInput>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const ctx = await requireRole('agent')
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() }
    if (patch.name !== undefined) {
      const name = clean(patch.name)
      if (!name) return { ok: false, error: 'O nome da empresa é obrigatório.' }
      // Não deixa colidir com outra empresa da conta.
      const clash = firstOrNull(
        await db
          .select({ id: companies.id })
          .from(companies)
          .where(
            and(
              eq(companies.accountId, ctx.accountId),
              sql`lower(${companies.name}) = lower(${name})`,
              sql`${companies.id} <> ${id}`,
            ),
          )
          .limit(1),
      )
      if (clash) return { ok: false, error: 'Já existe outra empresa com esse nome.' }
      set.name = name
    }
    if (patch.segment !== undefined) set.segment = clean(patch.segment)
    if (patch.website !== undefined) set.website = clean(patch.website)
    if (patch.phone !== undefined) set.phone = clean(patch.phone)
    if (patch.notes !== undefined) set.notes = clean(patch.notes)

    const updated = await db
      .update(companies)
      .set(set)
      .where(and(eq(companies.id, id), eq(companies.accountId, ctx.accountId)))
      .returning({ id: companies.id, name: companies.name })
    if (updated.length === 0) return { ok: false, error: 'Empresa não encontrada.' }
    // Mantém o texto legado dos contatos em sincronia com o nome da empresa
    // (p/ {{empresa}} nos disparos e telas que ainda leem contacts.company).
    if (set.name) {
      await db
        .update(contacts)
        .set({ company: updated[0].name })
        .where(and(eq(contacts.companyId, id), eq(contacts.accountId, ctx.accountId)))
    }
    revalidatePath('/empresas')
    revalidatePath(`/empresas/${id}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Falha ao salvar.' }
  }
}

/** Exclui uma empresa. Os contatos ficam (company_id vira NULL pela FK). */
export async function deleteCompany(
  id: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await requireRole('agent')
    // Zera o texto legado dos contatos desta empresa (o company_id some via FK).
    await db
      .update(contacts)
      .set({ company: null })
      .where(and(eq(contacts.companyId, id), eq(contacts.accountId, ctx.accountId)))
    const del = await db
      .delete(companies)
      .where(and(eq(companies.id, id), eq(companies.accountId, ctx.accountId)))
      .returning({ id: companies.id })
    if (del.length === 0) return { error: 'Empresa não encontrada.' }
    revalidatePath('/empresas')
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao excluir.' }
  }
}

/** Vincula/desvincula um contato a uma empresa (companyId null = desvincula). */
export async function setContactCompany(
  contactId: string,
  companyId: string | null,
): Promise<{ error: string | null }> {
  try {
    const ctx = await requireRole('agent')
    let companyName: string | null = null
    if (companyId) {
      const co = firstOrNull(
        await db
          .select({ name: companies.name })
          .from(companies)
          .where(and(eq(companies.id, companyId), eq(companies.accountId, ctx.accountId)))
          .limit(1),
      )
      if (!co) return { error: 'Empresa não encontrada.' }
      companyName = co.name
    }
    const updated = await db
      .update(contacts)
      // Mantém o texto legado (contacts.company) sincronizado com o nome.
      .set({ companyId, company: companyName })
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)))
      .returning({ id: contacts.id })
    if (updated.length === 0) return { error: 'Contato não encontrado.' }
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao vincular.' }
  }
}
