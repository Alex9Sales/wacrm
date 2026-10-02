// Número da linha NA PLANILHA (1 = cabeçalho) de cada objeto que o
// parseSheet devolve — 02/10/2026: a prévia da importação aponta "Linha 7:
// 'a combinar'" pra pessoa achar a célula no Excel.
//
// Vai numa chave Symbol NÃO enumerável: não aparece em Object.keys/entries
// (as colunas extras da importação de vendas viram metadata por
// Object.entries), nem no spread, nem em comparação de teste. Módulo à parte
// (sem exceljs) porque o server action da importação também lê dinheiro.

const ROW_NUMBER = Symbol('linhaDaPlanilha')

/** Marca o objeto com a linha da planilha de onde ele veio. */
export function tagRow(obj: Record<string, unknown>, line: number): void {
  Object.defineProperty(obj, ROW_NUMBER, { value: line, enumerable: false })
}

/** Linha da planilha de onde veio o objeto (1 = cabeçalho); null se não veio do parseSheet. */
export function sheetRowNumber(row: object): number | null {
  const n = (row as Record<symbol, unknown>)[ROW_NUMBER]
  return typeof n === 'number' ? n : null
}
