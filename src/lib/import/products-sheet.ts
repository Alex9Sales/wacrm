// Planilha do catálogo (Configurações → Produtos e serviços → Importar) →
// itens prontos pro importProducts. Puro: saiu de dentro do products-panel
// pra ter teste.
//
// 02/10/2026: o preço passa pelo parseImportMoney (lib/import/money) — o
// toPriceNum antigo lia "1,028.67" como 1,028 e transformava qualquer texto
// em R$ 0 calado. Linha com preço que não é número fica DE FORA e volta em
// `errors` (com a linha da planilha) pra tela avisar antes de importar. Dá
// pra corrigir e importar de novo: item com nome já existente é ignorado.

import { readMoneyColumn, type MoneyCellError } from './money'

export interface ParsedProductImport {
  name: string
  description: string | null
  unitPrice: number
  kind: 'product' | 'service'
}

/** Cabeçalho sem acento/caixa, p/ casar colunas de forma tolerante. */
function norm(s: string) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
}

/**
 * Mapeia as colunas Nome/Preço/Descrição/Tipo. Sem coluna de nome → nada.
 * Linha sem nome é pulada (como sempre); preço vazio = R$ 0 (como sempre);
 * preço inválido → `errors`, e o item não entra em `items`.
 */
export function mapProductRows(json: Record<string, unknown>[]): {
  items: ParsedProductImport[]
  errors: MoneyCellError[]
} {
  if (json.length === 0) return { items: [], errors: [] }
  const keys = Object.keys(json[0])
  const find = (re: RegExp) => keys.find((k) => re.test(norm(k)))
  const nameKey = find(/nome|produto|servico|item|name/)
  const priceKey = find(/preco|valor|price/)
  const descKey = find(/descri|detalhe|description|obs/)
  const kindKey = find(/tipo|categoria|kind/)
  if (!nameKey) return { items: [], errors: [] }

  const nameOf = (row: Record<string, unknown>) => String(row[nameKey] ?? '').trim()
  const named = json.filter((row) => nameOf(row) !== '')
  const price = readMoneyColumn(named, priceKey, nameOf)

  const items: ParsedProductImport[] = []
  named.forEach((row, i) => {
    const cell = price.cells[i]
    if (cell.invalid) return
    const kindRaw = kindKey ? norm(String(row[kindKey] ?? '')) : ''
    items.push({
      name: nameOf(row),
      description: descKey ? String(row[descKey] ?? '').trim() || null : null,
      unitPrice: cell.value ?? 0,
      kind: /servi|service/.test(kindRaw) ? 'service' : 'product',
    })
  })
  return { items, errors: price.errors }
}
