'use server'

// ============================================================
// Catálogo de Produtos/Serviços (Config → Produtos e serviços).
// Leituras account-scoped; escritas exigem agent+. Reutilizável nos produtos
// do negócio (deal_products).
// ============================================================

import { and, asc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { db, products } from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'

export type ProductKind = 'product' | 'service'

export interface ProductRow {
  id: string
  name: string
  description: string | null
  kind: ProductKind
  unit_price: number
  link_url: string | null
  active: boolean
  created_at: string
}

export interface ProductInput {
  name: string
  description?: string | null
  kind?: ProductKind
  unitPrice?: number
  linkUrl?: string | null
  active?: boolean
}

function clean(v: string | null | undefined): string | null {
  const t = (v ?? '').trim()
  return t ? t : null
}
function parsePrice(v: number | undefined): string {
  const n = Number(v ?? 0)
  return isFinite(n) && n >= 0 ? n.toFixed(2) : '0.00'
}

/** Lista o catálogo (ativos primeiro por padrão; opção de incluir inativos). */
export async function listProducts(
  opts: { includeInactive?: boolean } = {},
): Promise<ProductRow[]> {
  const ctx = await getCurrentAccount()
  const where = [eq(products.accountId, ctx.accountId)]
  if (!opts.includeInactive) where.push(eq(products.active, true))
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
      kind: products.kind,
      unit_price: products.unitPrice,
      link_url: products.linkUrl,
      active: products.active,
      created_at: products.createdAt,
    })
    .from(products)
    .where(and(...where))
    .orderBy(asc(products.name))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    kind: (r.kind as ProductKind) ?? 'product',
    unit_price: Number(r.unit_price ?? 0),
    link_url: r.link_url ?? null,
    active: Boolean(r.active),
    created_at: r.created_at as string,
  }))
}

export async function createProduct(
  input: ProductInput,
): Promise<{ ok: true; product: ProductRow } | { ok: false; error: string }> {
  try {
    const ctx = await requireRole('agent')
    const name = clean(input.name)
    if (!name) return { ok: false, error: 'O nome é obrigatório.' }
    const inserted = firstOrThrow(
      await db
        .insert(products)
        .values({
          accountId: ctx.accountId,
          name,
          description: clean(input.description),
          kind: input.kind === 'service' ? 'service' : 'product',
          unitPrice: parsePrice(input.unitPrice),
          linkUrl: clean(input.linkUrl),
          active: input.active ?? true,
          createdBy: ctx.userId,
        })
        .returning({
          id: products.id,
          name: products.name,
          description: products.description,
          kind: products.kind,
          unit_price: products.unitPrice,
          link_url: products.linkUrl,
          active: products.active,
          created_at: products.createdAt,
        }),
    )
    revalidatePath('/settings')
    return {
      ok: true,
      product: {
        id: inserted.id,
        name: inserted.name,
        description: inserted.description ?? null,
        kind: (inserted.kind as ProductKind) ?? 'product',
        unit_price: Number(inserted.unit_price ?? 0),
        link_url: inserted.link_url ?? null,
        active: Boolean(inserted.active),
        created_at: inserted.created_at as string,
      },
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Falha ao criar.' }
  }
}

export async function updateProduct(
  id: string,
  patch: Partial<ProductInput>,
): Promise<{ error: string | null }> {
  try {
    const ctx = await requireRole('agent')
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() }
    if (patch.name !== undefined) {
      const name = clean(patch.name)
      if (!name) return { error: 'O nome é obrigatório.' }
      set.name = name
    }
    if (patch.description !== undefined) set.description = clean(patch.description)
    if (patch.kind !== undefined)
      set.kind = patch.kind === 'service' ? 'service' : 'product'
    if (patch.unitPrice !== undefined) set.unitPrice = parsePrice(patch.unitPrice)
    if (patch.linkUrl !== undefined) set.linkUrl = clean(patch.linkUrl)
    if (patch.active !== undefined) set.active = patch.active
    const updated = await db
      .update(products)
      .set(set)
      .where(and(eq(products.id, id), eq(products.accountId, ctx.accountId)))
      .returning({ id: products.id })
    if (updated.length === 0) return { error: 'Item não encontrado.' }
    revalidatePath('/settings')
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao salvar.' }
  }
}

/** Importa itens em lote (CSV/XLSX já parseado no cliente). Pula nomes que já
 *  existem (case-insensitive) e linhas sem nome. Retorna criados/pulados. */
export async function importProducts(
  rows: {
    name: string
    description?: string | null
    unitPrice?: number
    kind?: ProductKind
  }[],
): Promise<{ created: number; skipped: number; error?: string }> {
  try {
    const ctx = await requireRole('agent')
    if (!Array.isArray(rows) || rows.length === 0)
      return { created: 0, skipped: 0, error: 'Nada para importar.' }
    const existing = await db
      .select({ name: products.name })
      .from(products)
      .where(eq(products.accountId, ctx.accountId))
    const seen = new Set(existing.map((e) => e.name.trim().toLowerCase()))
    const toInsert: (typeof products.$inferInsert)[] = []
    for (const r of rows) {
      const name = clean(r.name)
      if (!name) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      toInsert.push({
        accountId: ctx.accountId,
        name,
        description: clean(r.description),
        kind: r.kind === 'service' ? 'service' : 'product',
        unitPrice: parsePrice(r.unitPrice),
        active: true,
        createdBy: ctx.userId,
      })
    }
    let created = 0
    if (toInsert.length > 0) {
      await db.insert(products).values(toInsert)
      created = toInsert.length
    }
    revalidatePath('/settings')
    return { created, skipped: rows.length - created }
  } catch (err) {
    return {
      created: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : 'Falha ao importar.',
    }
  }
}

export async function deleteProduct(
  id: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await requireRole('agent')
    const del = await db
      .delete(products)
      .where(and(eq(products.id, id), eq(products.accountId, ctx.accountId)))
      .returning({ id: products.id })
    if (del.length === 0) return { error: 'Item não encontrado.' }
    revalidatePath('/settings')
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao excluir.' }
  }
}
