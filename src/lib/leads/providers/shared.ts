// ============================================================
// Mapeamento de campos compartilhado entre os providers de Lead Ads.
// Os formulários (Meta/TikTok) trazem uma lista de campos com nomes livres;
// aqui a gente normaliza pra nome/telefone/e-mail/empresa de forma tolerante.
// ============================================================

export interface FetchedLead {
  name: string | null
  phone: string | null
  email: string | null
  company: string | null
  /** Todos os campos do formulário (nome do campo em minúsculo → valores). */
  fields: Record<string, string>
  /** Metadados do anúncio (campanha/ad) quando disponíveis. */
  meta: Record<string, string>
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

/** Acha o 1º campo cujo nome bate exatamente numa das chaves; com `fuzzy`
 *  (padrão), cai pro 1º que CONTENHA a chave (cobre perguntas custom tipo
 *  "seu_telefone_whatsapp"). Desligue o fuzzy p/ nome — senão `name` casa
 *  `first_name`/`last_name` e engole o sobrenome. */
export function pickField(
  map: Record<string, string>,
  keys: string[],
  fuzzy = true,
): string | null {
  for (const k of keys) {
    const v = map[k]
    if (v && v.trim()) return v.trim()
  }
  if (!fuzzy) return null
  for (const k of keys) {
    const hit = Object.keys(map).find((name) => name.includes(k))
    if (hit && map[hit]?.trim()) return map[hit].trim()
  }
  return null
}

export function joinName(
  first: string | null,
  last: string | null,
): string | null {
  const parts = [first, last].filter(Boolean)
  return parts.length ? parts.join(' ') : null
}

/** Monta nome/telefone/e-mail/empresa a partir do mapa de campos (minúsculo). */
export function mapContactFields(fields: Record<string, string>): {
  name: string | null
  phone: string | null
  email: string | null
  company: string | null
} {
  return {
    name:
      // nome: exato só (sem fuzzy) → senão junta first+last (exato) — pra
      // "name" não engolir "first_name" e perder o sobrenome. Aceita as duas
      // grafias: com underscore (Meta/TikTok: first_name) e sem (LinkedIn manda
      // firstName/lastName → minúsculo firstname/lastname). Bug real do 1º teste
      // do LinkedIn (27/08): o nome vinha NULL por só reconhecer first_name.
      pickField(fields, ['full_name', 'fullname', 'name', 'nome'], false) ??
      joinName(
        pickField(fields, ['first_name', 'firstname', 'primeiro_nome'], false),
        pickField(fields, ['last_name', 'lastname', 'sobrenome'], false),
      ),
    phone: pickField(fields, [
      'phone_number',
      'phone',
      'telefone',
      'whatsapp',
      'celular',
      'mobile',
    ]),
    email: pickField(fields, ['email', 'e-mail']),
    company: pickField(fields, ['company_name', 'company', 'empresa']),
  }
}

/** Bloco de observações a partir dos campos “extras” + metadados do anúncio. */
export function buildLeadNotes(
  fields: Record<string, string>,
  meta: Record<string, string>,
  known: Array<string | null>,
): string {
  const knownSet = new Set(
    known.filter(Boolean).map((v) => (v as string).toLowerCase()),
  )
  const lines: string[] = []
  for (const [k, v] of Object.entries(meta)) {
    if (v?.trim()) lines.push(`${k}: ${v}`)
  }
  for (const [name, value] of Object.entries(fields)) {
    if (!value?.trim()) continue
    // pula os campos que já viraram nome/telefone/e-mail/empresa.
    if (knownSet.has(value.toLowerCase())) continue
    lines.push(`${name}: ${value}`)
  }
  return lines.join('\n')
}
