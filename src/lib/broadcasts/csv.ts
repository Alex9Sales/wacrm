// ============================================================
// Parser de CSV de contatos — compartilhado entre o Disparo de texto/e-mail
// (text-broadcast-form) e o assistente por template (step2-select-audience).
// Puro (sem DB, sem server-only) → roda no cliente.
// ============================================================

export interface CsvContact {
  phone: string
  name?: string
}

/** Split one CSV line into cells, respecting double-quoted fields (which may
 *  contain the separator). Accepts comma, semicolon or tab. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',' || ch === ';' || ch === '\t') {
      cells.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur)
  return cells.map((c) => c.trim())
}

const PHONE_HEADER = /(phone|telefone|celular|whats|fone|n[uú]mero|mobile|msisdn|contato)/i
const NAME_HEADER = /^(name|nome|full_?name|nome_completo|first_?name|primeiro_?nome|contato)$/i
const FIELD_HINT = /(phone|telefone|celular|whats|fone|n[uú]mero|name|nome|email|e-mail)/i

/** Count digits in a cell (for phone detection). */
function digitCount(s: string): number {
  return s.replace(/\D/g, '').length
}

/** Parse pasted/uploaded CSV text into { phone, name } rows. Header-aware:
 *  finds the phone/name columns by header name (so `phone_normalized`,
 *  `telefone`, etc. in any position work), and falls back to scanning each
 *  row for a phone-shaped cell when there is no usable header. Accepts comma,
 *  semicolon or tab separators and quoted fields. */
export function parseCsv(text: string): CsvContact[] {
  const out: CsvContact[] = []
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(splitCsvLine)
  if (rows.length === 0) return out

  const header = rows[0].map((h) => h.toLowerCase())
  // A first row is a header when it names a known field (phone/name/email…).
  const hasHeader = header.some((h) => FIELD_HINT.test(h))

  let phoneIdx = -1
  let nameIdx = -1
  if (hasHeader) {
    phoneIdx = header.findIndex((h) => PHONE_HEADER.test(h))
    nameIdx = header.findIndex((h) => NAME_HEADER.test(h))
    // A bare "contato" column is a weak name signal; only use it for the name
    // when we already found a distinct phone column.
    if (nameIdx === phoneIdx) nameIdx = -1
  }

  const dataRows = hasHeader ? rows.slice(1) : rows
  for (const parts of dataRows) {
    // 1) header-mapped phone column, else 2) positional col 0, else 3) the
    //    first cell in the row that looks like a phone (10–15 digits).
    let phoneCell = phoneIdx !== -1 ? (parts[phoneIdx] ?? '') : (parts[0] ?? '')
    if (digitCount(phoneCell) < 8) {
      const idx = parts.findIndex((p) => {
        const d = digitCount(p)
        return d >= 10 && d <= 15
      })
      if (idx !== -1) phoneCell = parts[idx]
    }
    const phone = phoneCell.replace(/[^\d+]/g, '')
    if (digitCount(phone) < 8) continue // too short to be a phone

    const nameCell =
      nameIdx !== -1 ? parts[nameIdx] : hasHeader ? undefined : parts[1]
    out.push({ phone, name: nameCell?.trim() || undefined })
  }
  return out
}
