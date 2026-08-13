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
      const line = `- ${r.name} (${kind}, ${formatPrice(r.unitPrice)})${desc}`
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
