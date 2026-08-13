import { and, asc, eq } from 'drizzle-orm'

import { db, products } from '@/db'

// ============================================================
// Catálogo no contexto do agente. Assim como o perfil da empresa, o catálogo
// de produtos/serviços ATIVOS é injetado SEMPRE no system prompt — é a FONTE
// DA VERDADE de preços. O usuário mantém preço num lugar só (Configurações →
// Produtos) e a IA já sabe; nada de redigitar preço em Q&A.
// ============================================================

/** Formata os produtos/serviços ativos da conta num bloco pro prompt.
 *  Null quando não há catálogo. Best-effort — nunca lança no hot path da IA. */
export async function formatCatalogForPrompt(
  accountId: string,
): Promise<string | null> {
  try {
    const rows = await db
      .select({
        name: products.name,
        description: products.description,
        kind: products.kind,
        unitPrice: products.unitPrice,
        linkUrl: products.linkUrl,
        imageUrl: products.imageUrl,
      })
      .from(products)
      .where(and(eq(products.accountId, accountId), eq(products.active, true)))
      .orderBy(asc(products.name))
      .limit(200)

    if (rows.length === 0) return null

    const lines: string[] = []
    let chars = 0
    for (const r of rows) {
      const kind = r.kind === 'service' ? 'serviço' : 'produto'
      const desc = r.description?.trim() ? ` — ${r.description.trim()}` : ''
      const link = r.linkUrl?.trim() ? ` — link: ${r.linkUrl.trim()}` : ''
      // Marca os itens que têm foto — o agente pode enviá-la (ver PHOTO_DIRECTIVE).
      const photo = r.imageUrl?.trim() ? ' — tem foto (pode enviar)' : ''
      const line = `- ${r.name} (${kind}, ${formatPrice(r.unitPrice)})${desc}${link}${photo}`
      // Cap defensivo: catálogo gigante não pode estourar o prompt.
      if (chars + line.length > 6000) {
        lines.push('- …(demais itens do catálogo)')
        break
      }
      chars += line.length
      lines.push(line)
    }
    return lines.join('\n')
  } catch {
    return null
  }
}

function formatPrice(v: string | null): string {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n) || n <= 0) return 'preço sob consulta'
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

/**
 * Resolve a URL da FOTO de um produto pelo nome (para o agente enviar como
 * anexo — ver PHOTO_DIRECTIVE). Casa por nome, ignorando caixa: exato primeiro,
 * senão o item ativo cujo nome contém/está contido no pedido. Null se não achar
 * ou o item não tiver foto. Best-effort — nunca lança no hot path.
 */
export async function resolveProductPhoto(
  accountId: string,
  name: string,
): Promise<{ url: string; name: string } | null> {
  const q = (name || '').trim().toLowerCase()
  if (!q) return null
  try {
    const rows = await db
      .select({ name: products.name, imageUrl: products.imageUrl })
      .from(products)
      .where(and(eq(products.accountId, accountId), eq(products.active, true)))
      .limit(200)
    const withPhoto = rows.filter((r) => r.imageUrl?.trim())
    if (withPhoto.length === 0) return null
    const exact = withPhoto.find((r) => r.name.trim().toLowerCase() === q)
    const partial =
      exact ??
      withPhoto.find((r) => {
        const n = r.name.trim().toLowerCase()
        return n.includes(q) || q.includes(n)
      })
    if (!partial || !partial.imageUrl) return null
    return { url: partial.imageUrl.trim(), name: partial.name }
  } catch {
    return null
  }
}
