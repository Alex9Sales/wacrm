// Utilitários de planilha (client-side) — leitura de CSV/XLSX e geração de CSV.
// Compartilhado pelo catálogo de produtos e pela importação de dados.

/**
 * Lê um arquivo CSV ou XLSX e devolve as linhas como objetos (chave = cabeçalho).
 * CSV é lido como TEXTO (UTF-8) — senão o SheetJS assume latin-1 e quebra os
 * acentos + o cabeçalho ("Preço" → "PreÃ§o"), fazendo o mapeamento falhar.
 */
export async function parseSheet(
  file: File,
): Promise<Record<string, unknown>[]> {
  const XLSX = await import('xlsx')
  const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv'
  const wb = isCsv
    ? XLSX.read(await file.text(), { type: 'string' })
    : XLSX.read(await file.arrayBuffer(), { type: 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  if (!sheet) return []
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
}

/** Escapa um campo CSV (aspas quando tem vírgula/aspas/quebra de linha). */
function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Monta o texto CSV (com BOM UTF-8 p/ o Excel abrir certo). */
export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  const lines = [headers.map(csvCell).join(',')]
  for (const r of rows) lines.push(r.map(csvCell).join(','))
  return '\uFEFF' + lines.join('\r\n')
}

/** Dispara o download de um CSV no navegador. */
export function downloadCsv(
  filename: string,
  headers: string[],
  rows: (string | number | null)[][],
): void {
  const blob = new Blob([toCsv(headers, rows)], {
    type: 'text/csv;charset=utf-8;',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
