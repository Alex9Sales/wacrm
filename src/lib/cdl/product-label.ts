// ============================================================
// 🏷️ Rótulo de produto em português natural.
//
// O histórico de compras guarda o produto como veio da fonte: o ERP manda
// "1.00x P-13 UltraGaz  Ultragaz" (quantidade com decimais, nome que já
// inclui a marca + a marca de novo, dois espaços); a planilha manda
// "1x P-13 Copagaz Copagaz". Nada disso pode chegar ao cliente ("Vi que já
// faz 77 dias do seu último 1.00x P-13 Copagaz Copagaz" — 07/09, Vania).
// Aqui vira "P-13 Copagaz" / "2 P-13 Ultragaz" / "P-13 Ultragaz e Vasilhame".
// Puro, client-safe, testado.
// ============================================================

export interface ProductItem {
  qty: number
  name: string
}

/** Marcas que o ERP grafa de outro jeito ("UltraGaz"). */
const BRAND_CASE: Record<string, string> = {
  ultragaz: 'Ultragaz',
  copagaz: 'Copagaz',
  supergasbras: 'Supergasbras',
  liquigas: 'Liquigás',
  liquigás: 'Liquigás',
}

/** "2.00x P-13 UltraGaz  Ultragaz, 1x Vasilhame" → [{2, "P-13 Ultragaz"}, {1, "Vasilhame"}] */
export function parseProductLabel(raw: string | null | undefined): ProductItem[] {
  const s = String(raw ?? '').trim()
  if (!s) return []
  return s
    .split(/\s*[,;]\s*/)
    .filter(Boolean)
    .map((part) => {
      let qty = 1
      let name = part.replace(/\s+/g, ' ').trim()
      const m = /^(\d+(?:[.,]\d+)?)\s*[xX]\s+(.+)$/.exec(name)
      if (m) {
        const n = Number(m[1].replace(',', '.'))
        qty = Number.isFinite(n) && n > 0 ? n : 1
        name = m[2].trim()
      }
      const words = name.split(' ')
      // Marca repetida no fim ("P-13 UltraGaz Ultragaz" → "P-13 Ultragaz").
      if (words.length >= 2) {
        const last = words[words.length - 1].toLowerCase()
        const dup = words.slice(0, -1).findIndex((w) => w.toLowerCase() === last)
        if (dup >= 0) words.pop()
      }
      name = words.map((w) => BRAND_CASE[w.toLowerCase()] ?? w).join(' ')
      return { qty, name }
    })
    .filter((i) => i.name)
}

const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toLocaleString('pt-BR'))

function joinNatural(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`
}

/** Com quantidade quando importa: "P-13 Copagaz" · "2 P-13 Ultragaz" · "P-13 Ultragaz e Vasilhame". */
export function humanizeProduct(raw: string | null | undefined, fallback = 'seu pedido'): string {
  const items = parseProductLabel(raw)
  if (!items.length) return fallback
  return joinNatural(items.map((i) => (i.qty > 1 ? `${fmtQty(i.qty)} ${i.name}` : i.name)))
}

/** Só os nomes, sem quantidade: "P-13 Copagaz" · "P-13 Ultragaz e Vasilhame". */
export function productNames(raw: string | null | undefined, fallback = 'seu pedido'): string {
  const items = parseProductLabel(raw)
  if (!items.length) return fallback
  return joinNatural(items.map((i) => i.name))
}
