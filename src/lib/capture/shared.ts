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
  /** Botão "💬 WhatsApp" na landing (usa o link rastreado do formulário). */
  showWhatsapp: boolean
  /** Slug de uma página de agendamento → botão "📅 Agendar horário". */
  schedulerSlug: string | null
  /** Fundo do hero (estilo Haikei/Trianglify, gerado por código na cor da marca). */
  heroStyle: 'gradient' | 'mesh' | 'waves' | 'blobs' | 'grid' | 'lowpoly'
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
  showWhatsapp: false,
  schedulerSlug: null,
  heroStyle: 'gradient',
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
    showWhatsapp: !!o.showWhatsapp,
    schedulerSlug: str(o.schedulerSlug, 80) || null,
    heroStyle:
      o.heroStyle === 'waves' ||
      o.heroStyle === 'blobs' ||
      o.heroStyle === 'mesh' ||
      o.heroStyle === 'grid' ||
      o.heroStyle === 'lowpoly'
        ? o.heroStyle
        : 'gradient',
  }
}

// ------------------------------------------------------------
// Modelos prontos de landing (a "galeria" do RD, mas já escrita em pt-BR).
// Um clique aplica o modelo; "Criar com IA" adapta ao negócio depois.
// ------------------------------------------------------------
export interface CaptureTemplate {
  id: string
  emoji: string
  label: string
  headline: string
  description: string
  ctaText: string
  benefitsTitle: string
  benefits: CaptureBenefit[]
  submitLabel: string
  successMessage: string
  offerTitle: string | null
  offerText: string | null
  origin: string
}

export const CAPTURE_TEMPLATES: CaptureTemplate[] = [
  {
    id: 'demo',
    emoji: '🖥️',
    label: 'Demonstração / serviço',
    headline: 'Veja funcionando antes de decidir',
    description:
      'Deixe seu contato e a gente te mostra na prática como funciona — rápido, sem compromisso.',
    ctaText: 'Quero uma demonstração',
    benefitsTitle: 'Por que vale seus 30 minutos',
    benefits: [
      { title: 'Na prática, não no papel', description: 'Você vê o funcionamento real, com exemplos do seu dia a dia.' },
      { title: 'Tira-dúvidas ao vivo', description: 'Pergunte o que quiser — quem apresenta é quem entende do assunto.' },
      { title: 'Sem compromisso', description: 'Terminou a demonstração, a decisão é sua. Sem pressão.' },
    ],
    submitLabel: 'Agendar demonstração',
    successMessage: 'Prontinho! 🎉 Já vamos te chamar no WhatsApp pra combinar o melhor horário.',
    offerTitle: null,
    offerText: null,
    origin: 'Demonstração',
  },
  {
    id: 'cupom',
    emoji: '🏷️',
    label: 'Cupom / promoção',
    headline: 'Ganhe um desconto exclusivo 🏷️',
    description:
      'Deixe seu contato e receba seu cupom no WhatsApp — válido por tempo limitado.',
    ctaText: 'Quero meu cupom',
    benefitsTitle: 'Como funciona',
    benefits: [
      { title: 'Cadastre-se em 30 segundos', description: 'Só nome e WhatsApp — sem formulário gigante.' },
      { title: 'Cupom direto no WhatsApp', description: 'Você recebe o código na hora, no seu zap.' },
      { title: 'Use quando quiser', description: 'Aproveite no prazo da promoção, sem pegadinha.' },
    ],
    submitLabel: 'Receber meu cupom',
    successMessage: 'Cupom garantido! 🎉 Olha seu WhatsApp — ele chega em instantes.',
    offerTitle: '🎁 Seu cupom está a caminho',
    offerText: 'Chame a gente no WhatsApp se quiser usar agora mesmo.',
    origin: 'Promoção',
  },
  {
    id: 'material',
    emoji: '📕',
    label: 'E-book / material',
    headline: 'Baixe grátis o material completo 📕',
    description:
      'Um guia direto ao ponto pra você aplicar hoje. Deixe seu contato e receba no WhatsApp.',
    ctaText: 'Baixar grátis',
    benefitsTitle: 'O que você vai ver',
    benefits: [
      { title: 'Passo a passo aplicável', description: 'Nada de teoria vazia — checklist pra usar no mesmo dia.' },
      { title: 'Exemplos reais', description: 'Casos práticos que mostram o antes e o depois.' },
      { title: 'Leitura rápida', description: 'Direto ao ponto — você termina em uma sentada.' },
    ],
    submitLabel: 'Quero o material',
    successMessage: 'Enviado! 🎉 O material chega no seu WhatsApp em instantes.',
    offerTitle: null,
    offerText: null,
    origin: 'Material',
  },
  {
    id: 'evento',
    emoji: '🎟️',
    label: 'Webinar / evento',
    headline: 'Garanta sua vaga no evento 🎟️',
    description:
      'Ao vivo e gratuito. Inscreva-se e receba o lembrete e o link de acesso no WhatsApp.',
    ctaText: 'Garantir minha vaga',
    benefitsTitle: 'O que rola no evento',
    benefits: [
      { title: 'Conteúdo ao vivo', description: 'Aprenda com quem faz — e pergunte em tempo real.' },
      { title: 'Lembrete no WhatsApp', description: 'A gente te avisa antes de começar, pra você não perder.' },
      { title: 'Bônus pra quem participa', description: 'Material exclusivo pra quem estiver ao vivo.' },
    ],
    submitLabel: 'Quero participar',
    successMessage: 'Vaga garantida! 🎉 O lembrete e o link chegam no seu WhatsApp.',
    offerTitle: null,
    offerText: null,
    origin: 'Evento',
  },
  {
    id: 'orcamento',
    emoji: '💬',
    label: 'Orçamento / contato',
    headline: 'Peça seu orçamento sem compromisso',
    description:
      'Conte o que você precisa e a gente responde no WhatsApp com uma proposta feita pra você.',
    ctaText: 'Pedir orçamento',
    benefitsTitle: 'Por que pedir por aqui',
    benefits: [
      { title: 'Resposta rápida', description: 'Seu pedido cai direto com quem resolve — sem fila de e-mail.' },
      { title: 'Proposta sob medida', description: 'Nada de tabela genérica: orçamento pro seu caso.' },
      { title: 'Tudo pelo WhatsApp', description: 'Combine os detalhes sem sair do aplicativo.' },
    ],
    submitLabel: 'Enviar pedido',
    successMessage: 'Recebido! 🎉 Já vamos te responder no WhatsApp com o orçamento.',
    offerTitle: null,
    offerText: null,
    origin: 'Orçamento',
  },
]

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
