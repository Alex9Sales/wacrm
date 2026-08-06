/**
 * vCard (.vcf) parsing for the contacts import modal. Produces the SAME shape
 * as {@link parseContactCsv} so the modal can hand either to `importContacts`
 * (which normalizes phones BR-style + dedupes 9th-digit). Handles vCard 2.1 /
 * 3.0 / 4.0: line unfolding, `FN`/`N`, one-or-many `TEL`, `EMAIL`, `ORG`.
 *
 * We do NOT guess a missing DDD here — the phone is passed through raw and the
 * server pipeline normalizes what it can (an export sem DDD stays unsendable,
 * same as a CSV). Cada telefone do cartão vira UMA linha (a pessoa pode ter
 * vários números), deduplicado por número dentro do cartão.
 */
import type {
  ParsedContactRow,
  ParseContactCsvResult,
} from './parse-contact-csv';

/** Unfold vCard logical lines: a line starting with space/tab continues the
 *  previous one (RFC 6350 §3.2). */
function unfold(text: string): string[] {
  const raw = text.split(/\r\n|\r|\n/);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Split "TEL;TYPE=CELL:+55 11 9…" into { name: 'TEL', params, value }. */
function parseLine(line: string): {
  name: string;
  params: string[];
  value: string;
} | null {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1).trim();
  const parts = head.split(';');
  const name = (parts[0] || '').toUpperCase();
  const params = parts.slice(1).map((p) => p.toUpperCase());
  return { name, params, value };
}

/** vCard 2.1 may quoted-printable-encode values; decode the common case so
 *  accented names come through (e.g. "=C3=A9" → "é"). Best-effort. */
function maybeDecodeQuotedPrintable(value: string, params: string[]): string {
  const isQP = params.some((p) => p.includes('QUOTED-PRINTABLE'));
  if (!isQP || !value.includes('=')) return value;
  try {
    const bytes: number[] = [];
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '=' && i + 2 < value.length) {
        bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(value.charCodeAt(i));
      }
    }
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  } catch {
    return value;
  }
}

/** Reconstruct a display name from the structured N field
 *  (Family;Given;Additional;Prefix;Suffix) → "Given Family". */
function nameFromN(value: string): string {
  const [family = '', given = ''] = value.split(';').map((s) => s.trim());
  return [given, family].filter(Boolean).join(' ').trim();
}

export function parseVCard(text: string): ParseContactCsvResult {
  const lines = unfold(text);
  const rows: ParsedContactRow[] = [];
  let hasCompanyColumn = false;

  let inCard = false;
  let fn = '';
  let structuredName = '';
  let company = '';
  let email = '';
  let phones: string[] = [];

  const flush = () => {
    const name = fn || structuredName || undefined;
    const seen = new Set<string>();
    for (const phone of phones) {
      const key = phone.replace(/[^0-9]/g, '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push({
        phone,
        name,
        email: email || undefined,
        company: company || undefined,
        tagNames: [],
        codes: [],
      });
    }
  };

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:VCARD')) {
      inCard = true;
      fn = structuredName = company = email = '';
      phones = [];
      continue;
    }
    if (upper.startsWith('END:VCARD')) {
      if (inCard) flush();
      inCard = false;
      continue;
    }
    if (!inCard) continue;

    const parsed = parseLine(line);
    if (!parsed) continue;
    const value = maybeDecodeQuotedPrintable(parsed.value, parsed.params);
    if (!value) continue;

    switch (parsed.name) {
      case 'FN':
        fn = value;
        break;
      case 'N':
        structuredName = nameFromN(value);
        break;
      case 'TEL':
        phones.push(value);
        break;
      case 'EMAIL':
        if (!email) email = value;
        break;
      case 'ORG':
        if (!company) {
          company = value.split(';')[0].trim();
          if (company) hasCompanyColumn = true;
        }
        break;
    }
  }

  return {
    rows,
    hasTagsColumn: false,
    hasCompanyColumn,
    hasCodesColumn: false,
  };
}
