// Captação self-serve — tipos + defaults PUROS (sem DB, sem server-only).
// Compartilhado entre a gestão no CRM, a rota pública /f/[slug] e o endpoint.

// ------------------------------------------------------------
// Landing page (conteúdo em volta do formulário).
// ------------------------------------------------------------
export interface CaptureBenefit {
  title: string
  description: string
}
export interface CaptureTestimonial {
  quote: string
  author: string
  role: string
}
export interface CaptureContent {
  /** 'form' = só o formulário (padrão); 'landing' = página completa. */
  mode: 'form' | 'landing'
  heroImage: string | null
  logo: string | null
  /** Cor de destaque (hex). null = roxo padrão. */
  brandColor: string | null
  benefitsTitle: string | null
  benefits: CaptureBenefit[]
  testimonials: CaptureTestimonial[]
  /** Texto do botão do hero (rola até o formulário). */
  ctaText: string | null
}

export const DEFAULT_CAPTURE_CONTENT: CaptureContent = {
  mode: 'form',
  heroImage: null,
  logo: null,
  brandColor: null,
  benefitsTitle: null,
  benefits: [],
  testimonials: [],
  ctaText: null,
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/

/** Sanea o conteúdo da landing (limita tamanhos, valida cor, corta vazios). */
export function normalizeCaptureContent(input: unknown): CaptureContent {
  const o = (input ?? {}) as Partial<CaptureContent>
  const str = (v: unknown, max = 400) =>
    typeof v === 'string' ? v.trim().slice(0, max) : ''
  const benefits = Array.isArray(o.benefits) ? o.benefits : []
  const testimonials = Array.isArray(o.testimonials) ? o.testimonials : []
  return {
    mode: o.mode === 'landing' ? 'landing' : 'form',
    heroImage: str(o.heroImage, 600) || null,
    logo: str(o.logo, 600) || null,
    brandColor:
      typeof o.brandColor === 'string' && HEX_RE.test(o.brandColor.trim())
        ? o.brandColor.trim()
        : null,
    benefitsTitle: str(o.benefitsTitle, 120) || null,
    benefits: benefits
      .map((b) => ({ title: str(b?.title, 120), description: str(b?.description, 300) }))
      .filter((b) => b.title || b.description)
      .slice(0, 6),
    testimonials: testimonials
      .map((t) => ({
        quote: str(t?.quote, 400),
        author: str(t?.author, 80),
        role: str(t?.role, 120),
      }))
      .filter((t) => t.quote)
      .slice(0, 6),
    ctaText: str(o.ctaText, 40) || null,
  }
}

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
