// Captação self-serve — tipos + defaults PUROS (sem DB, sem server-only).
// Compartilhado entre a gestão no CRM, a rota pública /f/[slug] e o endpoint.

export type CaptureFieldKey =
  | 'nome'
  | 'telefone'
  | 'email'
  | 'empresa'
  | 'mensagem'

export interface CaptureField {
  key: CaptureFieldKey
  label: string
  required: boolean
}

/** Metadados de cada campo padrão (rótulo sugerido + tipo do input público). */
export const CAPTURE_FIELD_DEFS: Record<
  CaptureFieldKey,
  { label: string; inputType: 'text' | 'tel' | 'email' | 'textarea' }
> = {
  nome: { label: 'Nome', inputType: 'text' },
  telefone: { label: 'WhatsApp', inputType: 'tel' },
  email: { label: 'E-mail', inputType: 'email' },
  empresa: { label: 'Empresa', inputType: 'text' },
  mensagem: { label: 'Mensagem', inputType: 'textarea' },
}

export const CAPTURE_FIELD_ORDER: CaptureFieldKey[] = [
  'nome',
  'telefone',
  'empresa',
  'email',
  'mensagem',
]

// telefone é SEMPRE obrigatório: é a chave do lead num CRM de WhatsApp (ingestLead
// precisa do rawPhone). nome também vem obrigatório por padrão.
export const DEFAULT_CAPTURE_FIELDS: CaptureField[] = [
  { key: 'nome', label: 'Nome', required: true },
  { key: 'telefone', label: 'WhatsApp', required: true },
  { key: 'email', label: 'E-mail', required: false },
  { key: 'mensagem', label: 'Como podemos te ajudar?', required: false },
]

export const DEFAULT_CAPTURE_HEADLINE = 'Fale com a gente'
export const DEFAULT_CAPTURE_SUBMIT = 'Enviar'
export const DEFAULT_CAPTURE_SUCCESS =
  'Recebemos seus dados! Em breve entramos em contato. 💜'

/** Sanea a lista de campos: só chaves conhecidas, telefone sempre presente e
 *  obrigatório, nome sempre presente. Preserva ordem canônica. */
export function normalizeCaptureFields(input: unknown): CaptureField[] {
  const arr = Array.isArray(input) ? (input as Partial<CaptureField>[]) : []
  const byKey = new Map<CaptureFieldKey, CaptureField>()
  for (const f of arr) {
    const key = f?.key as CaptureFieldKey
    if (!key || !(key in CAPTURE_FIELD_DEFS)) continue
    byKey.set(key, {
      key,
      label: (f?.label ?? '').toString().trim() || CAPTURE_FIELD_DEFS[key].label,
      required: !!f?.required,
    })
  }
  // Garante nome + telefone presentes; telefone sempre obrigatório.
  if (!byKey.has('nome'))
    byKey.set('nome', { key: 'nome', label: 'Nome', required: true })
  if (!byKey.has('telefone'))
    byKey.set('telefone', { key: 'telefone', label: 'WhatsApp', required: true })
  const tel = byKey.get('telefone')!
  tel.required = true
  return CAPTURE_FIELD_ORDER.filter((k) => byKey.has(k)).map(
    (k) => byKey.get(k)!,
  )
}

/** Slug base a partir do nome (sem sufixo aleatório — quem gera o único é a action). */
export function slugifyName(name: string): string {
  return (name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}
