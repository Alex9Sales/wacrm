// ============================================================
// Pure number handling for the dialer. Extracted so the normalization can be
// tested without a DOM — dialing the WRONG number is worse than not dialing,
// so this is the part that must be pinned down.
// ============================================================

/**
 * Turn whatever the agent typed into the digits we dial.
 *
 * Digits only, and guarantee a Brazilian country code: a bare DDD+number
 * (≤11 digits, not already starting with 55) gets a 55 prefix. Anything
 * longer or already prefixed is passed through as-is — the backend's
 * check-exists resolves the canonical chatId (LID / 9th-digit) from here.
 */
export function toDialDigits(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (!d) return '';
  if (d.length <= 11 && !d.startsWith('55')) return `55${d}`;
  return d;
}

/** A dialable number must be at least country + DDD + an 8-digit landline. */
export function isDialable(raw: string): boolean {
  return toDialDigits(raw).length >= 12;
}

/** Pretty-print what the agent typed: +55 (67) 99999-9999, best effort. */
export function formatDisplay(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (!d) return '';
  const s = d.startsWith('55') ? d.slice(2) : d;
  const ddd = s.slice(0, 2);
  const rest = s.slice(2);
  if (!ddd) return `+55`;
  if (!rest) return `+55 (${ddd}`;
  const head = rest.length > 4 ? rest.slice(0, rest.length - 4) : rest;
  const tail = rest.length > 4 ? rest.slice(rest.length - 4) : '';
  return `+55 (${ddd}) ${head}${tail ? `-${tail}` : ''}`;
}
