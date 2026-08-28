'use server'

// ============================================================
// Importação de dados de outros CRMs (estilo "Importar dados gerais" do RD).
// Dois tipos: (A) Empresas & Contatos; (B) Negociações/Oportunidades.
// A LÓGICA fica aqui (server actions) p/ ser reusada pela UI E, depois, pela
// API do agente IA (com aprovação). Tudo account-scoped; escrita = agent+.
// ============================================================

import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import {
  db,
  companies,
  contacts,
  deals,
  pipelineStages,
  user,
  member,
  customerTransactions,
} from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { findOrCreateContact } from '@/lib/api/v1/contacts'
import { normalizeInboundPhoneBR } from '@/lib/whatsapp/phone-utils'

function clean(v: unknown): string | null {
  const t = String(v ?? '').trim()
  return t ? t : null
}

/** Telefone da planilha → E.164 digits (assume BR quando vem sem país). */
function importPhone(raw: unknown): string {
  let d = normalizeInboundPhoneBR(String(raw ?? '')).replace(/\D/g, '')
  if (!d) return ''
  // Nacional BR sem código do país (DDD + número) → prefixa 55.
  if ((d.length === 10 || d.length === 11) && !d.startsWith('55')) d = '55' + d
  return d
}

/** Acha (case-insensitive) ou cria a empresa pelo nome. */
async function resolveCompany(
  accountId: string,
  userId: string,
  rawName: unknown,
  segment?: string | null,
): Promise<{ id: string; created: boolean } | null> {
  const name = clean(rawName)
  if (!name) return null
  const existing = firstOrNull(
    await db
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          eq(companies.accountId, accountId),
          sql`lower(${companies.name}) = lower(${name})`,
        ),
      )
      .limit(1),
  )
  if (existing) return { id: existing.id, created: false }
  try {
    const ins = firstOrThrow(
      await db
        .insert(companies)
        .values({
          accountId,
          name,
          segment: clean(segment),
          createdBy: userId,
        })
        .returning({ id: companies.id }),
    )
    return { id: ins.id, created: true }
  } catch {
    const raced = firstOrNull(
      await db
        .select({ id: companies.id })
        .from(companies)
        .where(
          and(
            eq(companies.accountId, accountId),
            sql`lower(${companies.name}) = lower(${name})`,
          ),
        )
        .limit(1),
    )
    return raced ? { id: raced.id, created: false } : null
  }
}

// ---- (A) Empresas & Contatos ----

export interface ImportContactRow {
  companyName?: string | null
  contactName?: string | null
  phone?: string | null
  email?: string | null
  segment?: string | null
}

export interface ImportContactsResult {
  companiesCreated: number
  contactsCreated: number
  contactsLinked: number
  skipped: number
  error?: string
}

export async function importCompaniesContacts(
  rows: ImportContactRow[],
): Promise<ImportContactsResult> {
  const res: ImportContactsResult = {
    companiesCreated: 0,
    contactsCreated: 0,
    contactsLinked: 0,
    skipped: 0,
  }
  try {
    const ctx = await requireRole('agent')
    if (!Array.isArray(rows) || rows.length === 0)
      return { ...res, error: 'Nada para importar.' }

    for (const row of rows) {
      const companyName = clean(row.companyName)
      const phone = importPhone(row.phone)
      const contactName = clean(row.contactName)
      // Linha sem empresa E sem contato válido → pula.
      if (!companyName && !phone) {
        res.skipped++
        continue
      }

      let companyId: string | null = null
      if (companyName) {
        const c = await resolveCompany(
          ctx.accountId,
          ctx.userId,
          companyName,
          row.segment,
        )
        if (c) {
          companyId = c.id
          if (c.created) res.companiesCreated++
        }
      }

      if (phone) {
        try {
          const { id, created } = await findOrCreateContact(
            ctx.accountId,
            ctx.userId,
            {
              phone,
              name: contactName ?? undefined,
              email: clean(row.email) ?? undefined,
              company: companyName ?? undefined,
            },
          )
          if (created) res.contactsCreated++
          // Vincula à empresa (entidade) + mantém texto legado em sync.
          if (companyId) {
            await db
              .update(contacts)
              .set({ companyId, company: companyName })
              .where(
                and(
                  eq(contacts.id, id),
                  eq(contacts.accountId, ctx.accountId),
                ),
              )
            res.contactsLinked++
          }
        } catch {
          res.skipped++
        }
      }
    }
    revalidatePath('/contacts')
    revalidatePath('/empresas')
    return res
  } catch (err) {
    return {
      ...res,
      error: err instanceof Error ? err.message : 'Falha ao importar.',
    }
  }
}

// ---- (B) Negociações / Oportunidades ----

export interface ImportDealRow {
  title?: string | null
  companyName?: string | null
  contactName?: string | null
  phone?: string | null
  email?: string | null
  source?: string | null
  campaign?: string | null
  segment?: string | null
  note?: string | null
  responsible?: string | null
  stage?: string | null
  value?: number | null
}

export interface ImportDealsResult {
  dealsCreated: number
  companiesCreated: number
  contactsCreated: number
  skipped: number
  error?: string
}

export async function importDeals(
  pipelineId: string,
  rows: ImportDealRow[],
): Promise<ImportDealsResult> {
  const res: ImportDealsResult = {
    dealsCreated: 0,
    companiesCreated: 0,
    contactsCreated: 0,
    skipped: 0,
  }
  try {
    const ctx = await requireRole('agent')
    if (!pipelineId) return { ...res, error: 'Escolha o funil de destino.' }
    if (!Array.isArray(rows) || rows.length === 0)
      return { ...res, error: 'Nada para importar.' }

    // Etapas do funil (p/ casar "Etapa" por nome; fallback = primeira).
    const stages = await db
      .select({ id: pipelineStages.id, name: pipelineStages.name })
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipelineId))
      .orderBy(asc(pipelineStages.position))
    if (stages.length === 0)
      return { ...res, error: 'O funil escolhido não tem etapas.' }
    const stageByName = new Map(
      stages.map((s) => [s.name.trim().toLowerCase(), s.id]),
    )
    const firstStageId = stages[0].id

    // Membros da conta (p/ casar "Responsável" por nome).
    const members = await db
      .select({ id: user.id, name: user.name })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, ctx.accountId))
    const memberByName = new Map(
      members.map((m) => [(m.name ?? '').trim().toLowerCase(), m.id]),
    )

    for (const row of rows) {
      const title = clean(row.title) ?? clean(row.companyName) ?? clean(row.contactName)
      if (!title) {
        res.skipped++
        continue
      }
      const companyName = clean(row.companyName)
      const phone = importPhone(row.phone)

      let companyId: string | null = null
      if (companyName) {
        const c = await resolveCompany(
          ctx.accountId,
          ctx.userId,
          companyName,
          row.segment,
        )
        if (c) {
          companyId = c.id
          if (c.created) res.companiesCreated++
        }
      }

      let contactId: string | null = null
      if (phone) {
        try {
          const { id, created } = await findOrCreateContact(
            ctx.accountId,
            ctx.userId,
            {
              phone,
              name: clean(row.contactName) ?? undefined,
              email: clean(row.email) ?? undefined,
              company: companyName ?? undefined,
            },
          )
          contactId = id
          if (created) res.contactsCreated++
          if (companyId)
            await db
              .update(contacts)
              .set({ companyId, company: companyName })
              .where(
                and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)),
              )
        } catch {
          /* contato inválido: segue com o negócio sem contato */
        }
      }

      const stageId =
        (row.stage && stageByName.get(clean(row.stage)!.toLowerCase())) ||
        firstStageId
      const assignedTo =
        (row.responsible &&
          memberByName.get(clean(row.responsible)!.toLowerCase())) ||
        null
      const now = new Date().toISOString()

      await db.insert(deals).values({
        userId: ctx.userId,
        accountId: ctx.accountId,
        pipelineId,
        stageId,
        contactId,
        companyId,
        assignedTo,
        title,
        value: String(Number(row.value ?? 0) || 0),
        currency: 'BRL',
        notes: clean(row.note),
        source: clean(row.source),
        origin: clean(row.campaign),
        status: 'open',
        stageChangedAt: now,
      })
      res.dealsCreated++
    }
    revalidatePath('/pipelines')
    revalidatePath('/empresas')
    return res
  } catch (err) {
    return {
      ...res,
      error: err instanceof Error ? err.message : 'Falha ao importar.',
    }
  }
}

// ---- Export (para migração / backup) ----

export interface ExportContactRow {
  company: string | null
  name: string | null
  phone: string
  email: string | null
}

export async function exportContactsData(): Promise<ExportContactRow[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      company: contacts.company,
      name: contacts.name,
      phone: contacts.phone,
      email: contacts.email,
    })
    .from(contacts)
    .where(eq(contacts.accountId, ctx.accountId))
    .orderBy(asc(contacts.name))
    .limit(50000)
  return rows.map((r) => ({
    company: r.company ?? null,
    name: r.name ?? null,
    phone: r.phone,
    email: r.email ?? null,
  }))
}

export interface ExportDealRow {
  title: string
  company: string | null
  contact_name: string | null
  contact_phone: string | null
  value: number
  stage: string | null
  responsible: string | null
  source: string | null
}

export async function exportDealsData(
  pipelineId: string,
): Promise<ExportDealRow[]> {
  const ctx = await getCurrentAccount()
  if (!pipelineId) return []
  const rows = await db
    .select({
      title: deals.title,
      company: companies.name,
      contact_name: contacts.name,
      contact_phone: contacts.phone,
      value: deals.value,
      stage: pipelineStages.name,
      responsible: user.name,
      source: deals.source,
    })
    .from(deals)
    .leftJoin(companies, eq(deals.companyId, companies.id))
    .leftJoin(contacts, eq(deals.contactId, contacts.id))
    .leftJoin(pipelineStages, eq(deals.stageId, pipelineStages.id))
    .leftJoin(user, eq(deals.assignedTo, user.id))
    .where(
      and(eq(deals.accountId, ctx.accountId), eq(deals.pipelineId, pipelineId)),
    )
    .orderBy(desc(deals.createdAt))
    .limit(50000)
  return rows.map((r) => ({
    title: r.title,
    company: r.company ?? null,
    contact_name: r.contact_name ?? null,
    contact_phone: r.contact_phone ?? null,
    value: Number(r.value ?? 0),
    stage: r.stage ?? null,
    responsible: r.responsible ?? null,
    source: r.source ?? null,
  }))
}

// ---- (C) Histórico comercial / Vendas (Customer Data Layer, Fase 2) ----
// Escreve em customer_transactions (razão comercial). Resolve o cliente pelo
// TELEFONE (mesma dedupe do importador de contatos) e liga a venda a ele.
// Idempotente: usa o número do pedido; sem ele, uma chave sintética estável —
// re-importar o MESMO arquivo não duplica.

export interface ImportTransactionRow {
  phone?: string | null
  contactName?: string | null
  occurredAt?: string | null // dd/mm/aaaa ou ISO
  amount?: string | number | null
  product?: string | null
  paymentMethod?: string | null
  externalId?: string | null // número do pedido (idempotência)
  type?: string | null
  status?: string | null
}

export interface ImportTransactionsResult {
  transactionsCreated: number
  transactionsUpdated: number
  contactsCreated: number
  skipped: number
  error?: string
}

/** "R$ 1.234,56" | "1234.56" | "1.234,56" → 1234.56 */
function parseImportAmount(v: unknown): number {
  if (typeof v === 'number') return isFinite(v) ? v : 0
  const s = String(v ?? '').replace(/[^\d.,-]/g, '')
  if (!s) return 0
  const n = parseFloat(s.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'))
  return isFinite(n) ? n : 0
}

/** "dd/mm/aaaa" | "aaaa-mm-dd" | ISO → ISO string; null se não parsear.
 *  Ancora ao meio-dia UTC pra a data não "virar" o dia por fuso. */
function parseImportDate(v: unknown): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  const br = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/)
  if (br) {
    const d = br[1].padStart(2, '0')
    const m = br[2].padStart(2, '0')
    const y = br[3].length === 2 ? '20' + br[3] : br[3]
    const dt = new Date(`${y}-${m}-${d}T12:00:00Z`)
    return isNaN(dt.getTime()) ? null : dt.toISOString()
  }
  const dt = new Date(s)
  return isNaN(dt.getTime()) ? null : dt.toISOString()
}

export async function importTransactions(
  rows: ImportTransactionRow[],
): Promise<ImportTransactionsResult> {
  const res: ImportTransactionsResult = {
    transactionsCreated: 0,
    transactionsUpdated: 0,
    contactsCreated: 0,
    skipped: 0,
  }
  try {
    const ctx = await requireRole('agent')
    if (!Array.isArray(rows) || rows.length === 0)
      return { ...res, error: 'Nada para importar.' }

    for (const row of rows) {
      const phone = importPhone(row.phone)
      // Sem telefone não dá pra resolver identidade — pula.
      if (!phone) {
        res.skipped++
        continue
      }

      let contactId: string
      try {
        const c = await findOrCreateContact(ctx.accountId, ctx.userId, {
          phone,
          name: clean(row.contactName) ?? undefined,
        })
        contactId = c.id
        if (c.created) res.contactsCreated++
      } catch {
        res.skipped++
        continue
      }

      const amount = parseImportAmount(row.amount)
      const occurredAt = parseImportDate(row.occurredAt)
      const product = clean(row.product)
      const paymentMethod = clean(row.paymentMethod)
      const type = clean(row.type) || 'purchase'
      const status = clean(row.status) || 'completed'
      // Idempotência: número do pedido; sem ele, chave sintética estável.
      const externalId =
        clean(row.externalId) ||
        ['imp', phone, occurredAt ?? '', String(amount), (product ?? '').toLowerCase()].join('|')
      const metadata: Record<string, unknown> = {}
      if (product) metadata.product = product

      try {
        const ins = firstOrNull(
          await db
            .insert(customerTransactions)
            .values({
              accountId: ctx.accountId,
              contactId,
              type,
              source: 'import',
              externalId,
              ...(occurredAt ? { occurredAt } : {}),
              amount: String(amount),
              currency: 'BRL',
              paymentMethod,
              status,
              metadata,
            })
            .onConflictDoUpdate({
              target: [
                customerTransactions.accountId,
                customerTransactions.source,
                customerTransactions.externalId,
              ],
              targetWhere: sql`external_id IS NOT NULL`,
              set: {
                type,
                amount: String(amount),
                paymentMethod,
                status,
                metadata,
                ...(occurredAt ? { occurredAt } : {}),
                updatedAt: sql`now()`,
              },
            })
            .returning({
              id: customerTransactions.id,
              inserted: sql<boolean>`(xmax = 0)`,
            }),
        )
        if (ins?.inserted) res.transactionsCreated++
        else res.transactionsUpdated++
      } catch {
        res.skipped++
      }
    }
    revalidatePath('/contacts')
    return res
  } catch (err) {
    return {
      ...res,
      error: err instanceof Error ? err.message : 'Falha ao importar.',
    }
  }
}
