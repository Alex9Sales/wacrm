// 🎂 Normalização do aniversário do contato (migr 0151). Lib pura: usada
// pelo cadastro, importação e (futuro) API v1; sem deps de servidor.

/**
 * 🎂 "2026-05-18" | "18/05/2026" | "18/05/26" | "18/05" (sem ano → 1900; só
 * mês/dia importam pro parabéns) → "YYYY-MM-DD" | null quando inválido/vazio.
 */
export function normalizeBirthday(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  let y: number
  let m: number
  let d: number
  let mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (mt) {
    y = +mt[1]
    m = +mt[2]
    d = +mt[3]
  } else if ((mt = s.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?$/))) {
    d = +mt[1]
    m = +mt[2]
    y = mt[3] ? (mt[3].length === 2 ? (+mt[3] < 30 ? 2000 : 1900) + +mt[3] : +mt[3]) : 1900
  } else return null
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
