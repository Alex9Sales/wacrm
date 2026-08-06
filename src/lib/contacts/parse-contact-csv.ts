/**
 * CSV parsing for the contacts import modal. Shared + unit-tested so
 * tag-column handling stays aligned with phone/name/email/company.
 */

export interface ParsedContactRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  /** Tag names from the optional `tags` column (comma/semicolon separated). */
  tagNames: string[];
  /** Customer codes from the optional código column (comma/semicolon split). */
  codes: string[];
}

/** Split a CSV cell into unique tag names (case-insensitive de-dupe). */
export function parseTagCell(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const seen = new Set<string>();
  const names: string[] = [];

  for (const part of value.split(/[,;]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}

/** Split a código cell into unique codes (case-SENSITIVE — codes may differ
 *  only by case in some ERPs). One contact can carry several codes. */
export function parseCodeCell(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const part of value.split(/[,;]/)) {
    const code = part.trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

// Header aliases (lowercased) so a planilha em PT-BR ("Telefone", "Nome",
// "E-mail", "Empresa") importa sem renomear a coluna pra inglês — mesma dor do
// disparo. Só a coluna de telefone é obrigatória.
const PHONE_HEADERS = [
  'phone',
  'phone_normalized',
  'telefone',
  'telephone',
  'celular',
  'cel',
  'whatsapp',
  'fone',
  'numero',
  'número',
  'tel',
  'mobile',
];
const NAME_HEADERS = [
  'name',
  'nome',
  'cliente',
  'nome do cliente',
  'razao social',
  'razão social',
];
const EMAIL_HEADERS = ['email', 'e-mail', 'e_mail', 'mail', 'correio'];
const COMPANY_HEADERS = [
  'company',
  'empresa',
  'companhia',
  'compania',
  'organizacao',
  'organização',
];
const TAGS_HEADERS = ['tags', 'tag', 'etiquetas', 'etiqueta'];

/** Header aliases accepted for the customer-code column (lowercased). */
const CODE_HEADERS = [
  'codigo_cliente',
  'codigo',
  'código',
  'código do cliente',
  'codigo do cliente',
  'codigos',
  'códigos',
  'customer_code',
  'customer_codes',
  'code',
];

export interface ParseContactCsvResult {
  rows: ParsedContactRow[];
  /** True when the CSV header includes a `tags` column. */
  hasTagsColumn: boolean;
  /** True when the CSV header includes a `company` column. */
  hasCompanyColumn: boolean;
  /** True when the CSV header includes a customer-code column. */
  hasCodesColumn: boolean;
}

export function parseContactCsv(text: string): ParseContactCsvResult {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false, hasCodesColumn: false };
  }

  const normHeaders = (line: string): string[] =>
    parseCsvLine(line).map((h) => h.trim().toLowerCase().replace(/["']/g, ''));
  const findCol = (hs: string[], aliases: string[]): number =>
    hs.findIndex((h) => aliases.includes(h));

  // Find the header row. Tolerate a leading title line (Numbers/Excel exports
  // sometimes put the sheet name on line 0) by scanning the first few lines for
  // the first one that carries a recognizable phone column.
  let headerLineIdx = -1;
  let headers: string[] = [];
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const hs = normHeaders(lines[i]);
    if (findCol(hs, PHONE_HEADERS) !== -1) {
      headerLineIdx = i;
      headers = hs;
      break;
    }
  }
  if (headerLineIdx === -1) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false, hasCodesColumn: false };
  }

  const phoneIdx = findCol(headers, PHONE_HEADERS);
  const nameIdx = findCol(headers, NAME_HEADERS);
  const emailIdx = findCol(headers, EMAIL_HEADERS);
  const companyIdx = findCol(headers, COMPANY_HEADERS);
  const tagsIdx = findCol(headers, TAGS_HEADERS);
  const codesIdx = headers.findIndex((h) => CODE_HEADERS.includes(h));

  const rows: ParsedContactRow[] = [];

  for (let i = headerLineIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCsvLine(line);
    const phone = values[phoneIdx]?.replace(/["']/g, '').trim();
    if (!phone) continue;

    rows.push({
      phone,
      name:
        nameIdx >= 0
          ? values[nameIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      email:
        emailIdx >= 0
          ? values[emailIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      company:
        companyIdx >= 0
          ? values[companyIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      tagNames:
        tagsIdx >= 0 ? parseTagCell(values[tagsIdx]?.replace(/["']/g, '')) : [],
      codes:
        codesIdx >= 0 ? parseCodeCell(values[codesIdx]?.replace(/["']/g, '')) : [],
    });
  }

  return {
    rows,
    hasTagsColumn: tagsIdx >= 0,
    hasCompanyColumn: companyIdx >= 0,
    hasCodesColumn: codesIdx >= 0,
  };
}

/** Simple CSV line parse (handles quoted fields). */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}
