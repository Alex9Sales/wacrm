// Utilitários de planilha (client-side) — leitura de CSV/XLSX e geração de CSV.
// Compartilhado pelo catálogo de produtos e pela importação de dados.
//
// 02/09: trocamos o SheetJS (`xlsx`, com CVE sem correção no npm) pelo
// `exceljs` (só pro XLSX) + um leitor de CSV próprio. A saída continua a
// mesma: uma linha = um objeto {cabeçalho: valor}, célula vazia = ''.

/** Lê um arquivo CSV ou XLSX e devolve as linhas como objetos (chave = cabeçalho). */
export async function parseSheet(
  file: File,
): Promise<Record<string, unknown>[]> {
  const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv'
  // CSV é lido como TEXTO (UTF-8) — assim acento e cabeçalho ("Preço") chegam certos.
  if (isCsv) return parseCsv(await file.text())
  return parseXlsx(await file.arrayBuffer())
}

// ---------------------------------------------------------------- XLSX

type CellValue = unknown

/** Transforma o valor da célula do exceljs em algo simples (string/number/boolean). */
function plainCell(v: CellValue): unknown {
  if (v == null) return ''
  if (v instanceof Date) {
    // Data do Excel → "DD/MM/AAAA" (é o formato que a importação entende).
    const dd = String(v.getUTCDate()).padStart(2, '0')
    const mm = String(v.getUTCMonth() + 1).padStart(2, '0')
    return `${dd}/${mm}/${v.getUTCFullYear()}`
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('result' in o) return plainCell(o.result) // fórmula → resultado
    if (Array.isArray(o.richText)) {
      return (o.richText as { text?: string }[]).map((r) => r.text ?? '').join('')
    }
    if ('text' in o) return plainCell(o.text) // hiperlink → texto visível
    if ('error' in o) return ''
    return String(v)
  }
  return v
}

export async function parseXlsx(buf: ArrayBuffer): Promise<Record<string, unknown>[]> {
  const { Workbook } = await import('exceljs')
  const wb = new Workbook()
  await wb.xlsx.load(buf)
  const ws = wb.worksheets[0]
  if (!ws) return []

  // Cabeçalho = 1ª linha. Coluna sem título é ignorada (igual ao SheetJS).
  const headers: { col: number; key: string }[] = []
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    const key = String(plainCell(cell.value) ?? '').trim()
    if (key) headers.push({ col, key })
  })
  if (headers.length === 0) return []

  const rows: Record<string, unknown>[] = []
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return
    const obj: Record<string, unknown> = {}
    let hasValue = false
    for (const h of headers) {
      const v = plainCell(row.getCell(h.col).value)
      if (v !== '' && v != null) hasValue = true
      obj[h.key] = v ?? ''
    }
    if (hasValue) rows.push(obj)
  })
  return rows
}

// ---------------------------------------------------------------- CSV

/** Descobre o separador olhando a 1ª linha (Excel em português salva com ';'). */
function detectDelimiter(firstLine: string): string {
  let best = ','
  let bestCount = -1
  for (const d of [',', ';', '\t']) {
    const n = firstLine.split(d).length - 1
    if (n > bestCount) {
      best = d
      bestCount = n
    }
  }
  return best
}

/** Parser CSV (RFC 4180): aspas, aspas duplicadas, quebra de linha dentro de aspas. */
export function parseCsvRows(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const firstLine = src.split(/\r?\n/, 1)[0] ?? ''
  const sep = delimiter ?? detectDelimiter(firstLine)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === sep) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export function parseCsv(text: string): Record<string, unknown>[] {
  const rows = parseCsvRows(text)
  if (rows.length === 0) return []
  const headers = rows[0].map((h) => h.trim())
  const out: Record<string, unknown>[] = []
  for (const r of rows.slice(1)) {
    if (r.every((c) => c.trim() === '')) continue
    const obj: Record<string, unknown> = {}
    headers.forEach((h, i) => {
      if (!h) return
      obj[h] = r[i] ?? ''
    })
    out.push(obj)
  }
  return out
}

// ---------------------------------------------------------------- geração de CSV

/** Escapa um campo CSV (aspas quando tem vírgula/aspas/quebra de linha). */
function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Monta o texto CSV (com BOM UTF-8 p/ o Excel abrir certo). */
export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  const lines = [headers.map(csvCell).join(',')]
  for (const r of rows) lines.push(r.map(csvCell).join(','))
  return '﻿' + lines.join('\r\n')
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
