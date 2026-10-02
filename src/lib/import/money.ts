// Valor em dinheiro vindo de PLANILHA (importação de produtos, negociações e
// histórico de vendas) → número. Puro (sem db): roda na prévia, no navegador,
// e no server action da importação.
//
// Por quê (02/10/2026, Rafael): cada importador tinha o seu toNum/toPriceNum/
// parseImportAmount — arrancavam tudo que não fosse dígito, ponto ou vírgula
// e davam parseFloat. "1,028.67" virava 1,028; "2x50" virava 250; e qualquer
// texto ("a combinar") virava R$ 0 CALADO. Agora a leitura é a mesma do resto
// do sistema (lib/format/parse-brl: "1.028,67", "R$ 1.028,67", "1.028",
// "1028.67") e o que não for número vira ERRO na prévia, com a linha.
//
// Do que o antigo aceitava, segue valendo o que é legítimo: a moeda escrita
// junto do número ("1500 reais", "R$1.500", "1.500,00 BRL", "1500 R$") —
// tirada ANTES do parser, que só conhece o "R$" na frente. Célula numérica do
// XLSX passa direto. Vazio continua "sem valor" (quem chama decide se é 0).
// "US$ 10" NÃO passa: dólar gravado como real seria o mesmo erro calado.

import { parseBrlField } from '@/lib/format/parse-brl'

import { sheetRowNumber } from './row-number'

/** "R$" em qualquer posição e as palavras de moeda soltas (não dentro de outra palavra). */
const MONEY_WORDS = /r\$|(?<![a-z])(?:reais|real|brl|rs)(?![a-z])/gi

export interface MoneyCell {
  /** Número lido; null = célula vazia OU inválida (ver `invalid`). */
  value: number | null
  /** Tinha alguma coisa na célula e não era dinheiro. */
  invalid: boolean
}

/** Uma célula de planilha → valor em reais (ver regra no topo). */
export function parseImportMoney(raw: unknown): MoneyCell {
  if (raw == null) return { value: null, invalid: false }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? { value: raw, invalid: false } : { value: null, invalid: true }
  }
  return parseBrlField(String(raw).replace(MONEY_WORDS, ' '))
}

export interface MoneyCellError {
  /** Linha da planilha (1 = cabeçalho); null quando não dá pra saber. */
  line: number | null
  /** Quem é a linha (produto, negócio, cliente) — pra achar na planilha. */
  label: string
  /** O que veio na célula. */
  raw: string
}

/**
 * Lê a coluna de dinheiro de todas as linhas. `cells[i]` corresponde a
 * `rows[i]`; `errors` lista só as inválidas, na ordem da planilha. Sem coluna
 * (`column` vazio) → tudo vazio, sem erro.
 */
export function readMoneyColumn(
  rows: Record<string, unknown>[],
  column: string | null | undefined,
  labelOf: (row: Record<string, unknown>) => string,
): { cells: MoneyCell[]; errors: MoneyCellError[] } {
  const cells: MoneyCell[] = []
  const errors: MoneyCellError[] = []
  for (const row of rows) {
    if (!column) {
      cells.push({ value: null, invalid: false })
      continue
    }
    const raw = row[column]
    const cell = parseImportMoney(raw)
    cells.push(cell)
    if (cell.invalid) {
      errors.push({
        line: sheetRowNumber(row),
        label: labelOf(row).trim().slice(0, 60),
        raw: String(raw ?? '').trim().slice(0, 60),
      })
    }
  }
  return { cells, errors }
}

/** "Linha 7 · Item A: "a combinar"" — uma linha do aviso da prévia. */
export function formatMoneyError(e: MoneyCellError): string {
  const where = [e.line != null ? `Linha ${e.line}` : '', e.label].filter(Boolean).join(' · ')
  return `${where || 'Linha sem identificação'}: "${e.raw}"`
}
