/** "+55 67 99000-1234" a partir de "5567990001234" (best-effort BR). */
export function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, '')
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4)
    const rest = d.slice(4)
    const mid = rest.length === 9 ? `${rest.slice(0, 5)}-${rest.slice(5)}` : `${rest.slice(0, 4)}-${rest.slice(4)}`
    return `+55 ${ddd} ${mid}`
  }
  return `+${d}`
}
