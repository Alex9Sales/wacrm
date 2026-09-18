// ============================================================
// RD Station Marketing — leitura do webhook de conversão.
//
// O RD manda o lead INTEIRO num JSON (`{ "leads": [ {...} ] }`): nome, e-mail,
// telefones, cidade, estado, tags, todos os campos personalizados preenchidos e
// — o que mais importa pra IA — a PRIMEIRA e a ÚLTIMA conversão, que dizem por
// onde a pessoa entrou. Com isso a Zélia não precisa perguntar "de onde você
// veio?": ela já sabe.
//
// Dois cuidados que vêm da documentação:
//   • o RD avisa que o formato do pacote "vai mudar em breve" → o parser aceita
//     tanto `{leads:[…]}` quanto um lead solto, e nunca exige um campo.
//   • lead importado ou cadastrado à mão NÃO dispara webhook. Os que já estão
//     na base têm que ser puxados à parte — não adianta esperar chegar aqui.
// ============================================================

import { type FetchedLead, str } from './shared'

/** Campos que já viram nome/telefone/e-mail — não repetir nas anotações. */
const CORE_KEYS = new Set([
  'id',
  'name',
  'email',
  'company',
  'mobile_phone',
  'personal_phone',
  'public_url',
  'created_at',
  'opportunity',
  'number_conversions',
  'first_conversion',
  'last_conversion',
  'custom_fields',
  'tags',
  'user',
  'bio',
])

type Bag = Record<string, unknown>

function isBag(v: unknown): v is Bag {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Nome legível da conversão ("Formulário X", "Landing Page Y"). */
function conversionLabel(v: unknown): string {
  if (!isBag(v)) return ''
  const content = isBag(v.content) ? v.content : {}
  return (
    str(v.source) ||
    str(content.identificador) ||
    str(content.identifier) ||
    str(v.conversion_identifier) ||
    ''
  ).trim()
}

/** Data da conversão, quando vier. */
function conversionDate(v: unknown): string {
  if (!isBag(v)) return ''
  return str(v.created_at).slice(0, 10)
}

/**
 * Um lead do RD → o formato que o motor de leads já entende.
 * Nunca lança: campo estranho vira anotação, campo faltando vira null.
 */
export function mapRdLead(raw: unknown): FetchedLead | null {
  if (!isBag(raw)) return null

  const fields: Record<string, string> = {}
  // Campos personalizados do RD: objeto { "Rótulo": "valor" }. É onde moram as
  // respostas do formulário (cidade, quanto pretende investir, etc.).
  if (isBag(raw.custom_fields)) {
    for (const [k, v] of Object.entries(raw.custom_fields)) {
      const value = Array.isArray(v) ? v.map(str).filter(Boolean).join(', ') : str(v)
      if (value.trim()) fields[k.trim().toLowerCase()] = value.trim()
    }
  }
  // Campos soltos do topo que não são os principais (cidade, estado, cargo…).
  for (const [k, v] of Object.entries(raw)) {
    if (CORE_KEYS.has(k)) continue
    const value = Array.isArray(v) ? v.map(str).filter(Boolean).join(', ') : str(v)
    if (value.trim() && !fields[k]) fields[k] = value.trim()
  }

  const meta: Record<string, string> = {}
  const first = conversionLabel(raw.first_conversion)
  const last = conversionLabel(raw.last_conversion)
  if (first) meta['Primeira conversão'] = first
  if (last && last !== first) meta['Última conversão'] = last
  const when = conversionDate(raw.last_conversion) || conversionDate(raw.first_conversion)
  if (when) meta['Data da conversão'] = when
  if (Array.isArray(raw.tags)) {
    const tags = raw.tags.map(str).filter(Boolean)
    if (tags.length) meta['Tags no RD'] = tags.join(', ')
  }
  const conversions = str(raw.number_conversions)
  if (conversions && conversions !== '1') meta['Conversões'] = conversions
  const publicUrl = str(raw.public_url)
  if (publicUrl) meta['Ficha no RD'] = publicUrl

  // Celular primeiro: é o que tem WhatsApp. Número fixo também é aceito — o CRM
  // pergunta ao WhatsApp se aquele número existe antes de desistir dele.
  const phone = (str(raw.mobile_phone) || str(raw.personal_phone)).trim() || null
  const name = str(raw.name).trim() || null
  const email = str(raw.email).trim() || null
  const company = str(raw.company).trim() || null

  if (!phone && !email && !name) return null
  return { name, phone, email, company, fields, meta }
}

/**
 * Corpo do webhook → lista de leads. Aceita `{leads:[…]}`, `{lead:{…}}`,
 * um array solto ou um lead solto — o RD já avisou que o formato vai mudar.
 */
export function parseRdWebhook(body: unknown): FetchedLead[] {
  const raw: unknown[] = Array.isArray(body)
    ? body
    : isBag(body)
      ? Array.isArray(body.leads)
        ? body.leads
        : isBag(body.lead)
          ? [body.lead]
          : [body]
      : []
  return raw.map(mapRdLead).filter((l): l is FetchedLead => !!l)
}

/** Identificador da conversão — vira a origem do lead no card do funil. */
export function rdOriginLabel(lead: FetchedLead): string {
  return lead.meta['Última conversão'] || lead.meta['Primeira conversão'] || 'RD Station'
}

export interface IntroChoice {
  /** Texto de abertura (pode ter partes separadas por uma linha "---"). */
  text: string | null
  /** Template da Meta pra esse tipo de lead; null = não usar template. */
  templateName: string | null
}

/**
 * Qual abertura mandar pra ESTE lead. Uma fonte do RD recebe conversões de
 * tipos diferentes — franquia, pedido de orçamento, vaga (Zelo 18/09: cliente
 * pedindo orçamento de limpeza recebeu o template "interesse no nosso modelo
 * de franquia"). `introTextRules` no provider_meta: [{match, text,
 * templateName?}], `match` = regex (sem diferenciar maiúscula) testada no
 * identificador da conversão; a 1ª que casar vence. Regra casada SEM
 * templateName não usa template — o template padrão é de outro tipo de lead.
 * Nenhuma casou → `introText` + `introTemplateName` da fonte.
 */
export function pickIntroForOrigin(meta: Record<string, unknown>, origin: string): IntroChoice {
  const rules = Array.isArray(meta.introTextRules) ? meta.introTextRules : []
  for (const r of rules) {
    if (!isBag(r) || typeof r.match !== 'string' || typeof r.text !== 'string') continue
    let re: RegExp
    try {
      re = new RegExp(r.match, 'i')
    } catch {
      continue // regex inválida na config não derruba o lead
    }
    if (re.test(origin)) {
      return {
        text: r.text.trim() || null,
        templateName: typeof r.templateName === 'string' && r.templateName.trim() ? r.templateName.trim() : null,
      }
    }
  }
  return {
    text: typeof meta.introText === 'string' && meta.introText.trim() ? meta.introText.trim() : null,
    templateName:
      typeof meta.introTemplateName === 'string' && meta.introTemplateName.trim()
        ? meta.introTemplateName.trim()
        : null,
  }
}
