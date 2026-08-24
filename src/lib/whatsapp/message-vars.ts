// ============================================================
// Message personalization for text broadcasts. Replaces {{token}}
// placeholders in a body with a recipient's contact fields, RecebAI-style.
//
// Supported tokens (pt-BR, case-insensitive, spaces tolerated):
//   {{nome}}          → contact name
//   {{primeiro_nome}} → first word of the name
//   {{telefone}}      → phone
//   {{email}}         → email
//   {{empresa}}       → company
//
// Optional fallback with a pipe: {{primeiro_nome|cliente}} → uses "cliente"
// when the contact has no first name. Unknown tokens are left untouched so
// a typo stays visible in the preview instead of silently vanishing.
// ============================================================

export interface ContactVars {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
}

/** Map of supported token → resolved value from a contact. */
export function contactTokenValues(c: ContactVars): Record<string, string> {
  const name = (c.name ?? '').trim();
  const firstName = name ? name.split(/\s+/)[0] : '';
  return {
    nome: name,
    primeiro_nome: firstName,
    telefone: (c.phone ?? '').trim(),
    email: (c.email ?? '').trim(),
    empresa: (c.company ?? '').trim(),
  };
}

/** The tokens users can insert (for the UI helper chips). */
export const SUPPORTED_TOKENS = [
  'primeiro_nome',
  'nome',
  'telefone',
  'email',
  'empresa',
] as const;

const TOKEN_RE = /\{\{\s*([a-zA-Z_]+)\s*(?:\|([^}]*))?\}\}/g;

// Chave SIMPLES ({nome}) também vale — usuário esquece a dupla direto (caso
// real: cadência do Rafael 24/08 saiu "{nome}," pro cliente). Normaliza pra
// {{...}} ANTES do render; lookbehind/lookahead pra não mexer em {{nome}}.
// Só tokens conhecidos — "{qualquer coisa}" de texto normal fica intacto.
const SINGLE_BRACE_RE =
  /(?<!\{)\{\s*(primeiro_nome|nome|telefone|email|empresa)\s*(\|[^}]*)?\}(?!\})/gi;

function normalizeSingleBraces(body: string): string {
  return body.replace(
    SINGLE_BRACE_RE,
    (_m, key: string, fb?: string) => `{{${key.toLowerCase()}${fb ?? ''}}}`,
  );
}

/**
 * Render `body`, replacing supported {{tokens}} with `values`. A token with
 * no value falls back to its `|fallback` (or empty string). Unknown tokens
 * are returned verbatim.
 */
export function renderMessageVars(
  body: string,
  values: Record<string, string>,
): string {
  return normalizeSingleBraces(body).replace(TOKEN_RE, (match, rawKey: string, rawFallback?: string) => {
    const key = rawKey.toLowerCase();
    if (!(key in values)) return match; // unknown token — leave as-is
    const value = values[key];
    if (value && value.length > 0) return value;
    return (rawFallback ?? '').trim();
  });
}

/** Convenience: render a body for a single contact. */
export function renderForContact(body: string, contact: ContactVars): string {
  return renderMessageVars(body, contactTokenValues(contact));
}
