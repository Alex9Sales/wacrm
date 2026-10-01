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
import { cleanOrigin, isGenericOrigin, isSyntheticConversion } from '../lead-facts'

/** Lead do RD + o que o webhook precisa saber antes de tratá-lo como lead. */
export interface RdLead extends FetchedLead {
  /**
   * Rótulo da conversão MAIS RECENTE quando quem a gerou foi o próprio RD CRM
   * ("Tarefa criada no RD Station CRM"…); null quando é do lead. Fica FORA de
   * `meta` de propósito: a observação do card não pode exibir esse rótulo como
   * se fosse uma conversão do lead (Zelo 01/10), mas o webhook precisa dele
   * pra não abrir card (ver isSyntheticConversion).
   */
  selfConversion: string | null
}

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

/** Uma conversão do RD (`first_conversion`/`last_conversion`) já lida. */
interface RdConversion {
  /** Todos os rótulos que o RD mandou pra ela, na ordem de preferência. */
  labels: string[]
  /**
   * Nome legível ("Formulário X", "Landing Page Y"): o 1º rótulo que diz algo
   * ("unknown" não é nome). '' quando nenhum diz.
   */
  label: string
  /**
   * O rótulo do próprio RD CRM, quando QUALQUER candidato for um — não só o
   * preferido. Zelo 01/10: com `source` vindo antes de `content.identificador`,
   * "Tarefa criada no RD Station CRM" podia ficar escondido atrás de outro
   * rótulo e passar pelo filtro.
   */
  synthetic: string | null
  /** AAAA-MM-DD, quando vier. */
  date: string
  /**
   * Campanha/canal de ANÚNCIO (`conversion_origin`: utm_campaign, fonte,
   * meio) — o "campo campanha" que o Jordan (Zelo 18/09) quer que a IA leia
   * pra saber de qual campanha o lead veio. Já sem os pedaços genéricos;
   * '' quando o RD não mandou nada útil.
   */
  campaign: string
  channel: string
}

function readConversion(v: unknown): RdConversion | null {
  if (!isBag(v)) return null
  const content = isBag(v.content) ? v.content : {}
  const labels = [v.source, content.identificador, content.identifier, v.conversion_identifier]
    .map((c) => str(c).trim())
    .filter(Boolean)
  const o = isBag(v.conversion_origin) ? v.conversion_origin : {}
  // Canal parte a parte: "facebook / unknown" → "facebook". Fonte e meio
  // genéricos → o `channel` agrupado do RD ("Paid Search", "Social"…), se útil.
  const channel =
    [o.source, o.medium]
      .map((s) => cleanOrigin(str(s)))
      .filter(Boolean)
      .join(' / ') || cleanOrigin(str(o.channel))
  return {
    labels,
    label: labels.find((l) => !isGenericOrigin(l)) ?? '',
    synthetic: labels.find((l) => isSyntheticConversion(l)) ?? null,
    date: str(v.created_at).slice(0, 10),
    campaign: cleanOrigin(str(o.campaign)),
    channel,
  }
}

/**
 * Um lead do RD → o formato que o motor de leads já entende.
 * Nunca lança: campo estranho vira anotação, campo faltando vira null.
 */
export function mapRdLead(raw: unknown): RdLead | null {
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
  const first = readConversion(raw.first_conversion)
  const last = readConversion(raw.last_conversion)
  // Só conversão do LEAD vira linha de origem. A do próprio RD CRM ("Tarefa
  // criada no RD Station CRM"…) não é "Última conversão" de ninguém — Zelo
  // 01/10: aparecia na nota como se o lead tivesse convertido nela.
  const firstReal = first && !first.synthetic ? first : null
  const lastReal = last && !last.synthetic ? last : null
  if (firstReal?.label) meta['Primeira conversão'] = firstReal.label
  if (lastReal?.label && lastReal.label !== firstReal?.label) meta['Última conversão'] = lastReal.label
  // Mais recente PRIMEIRO, sempre entre as reais: data, campanha e canal saem
  // da última conversão do lead e, no que ela não disser nada (genérico), da
  // primeira. Zelo 01/10: a conversão do RD CRM chegava com tudo "unknown" e
  // tomava o lugar da campanha boa do formulário.
  const real = [lastReal, firstReal].filter((c): c is RdConversion => !!c)
  const when = real.map((c) => c.date).find(Boolean)
  if (when) meta['Data da conversão'] = when
  const campaign = real.map((c) => c.campaign).find(Boolean)
  if (campaign) meta['Campanha'] = campaign
  const channel = real.map((c) => c.channel).find(Boolean)
  if (channel) meta['Canal da conversão'] = channel
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

  // A conversão que trouxe ESTE webhook é a última que tem rótulo (sem
  // rótulo nenhum, a primeira) — mesma régua de antes, agora olhando todos os
  // candidatos de rótulo de cada uma.
  const latest = last?.labels.length ? last : first
  const selfConversion = latest?.synthetic ?? null

  if (!phone && !email && !name) return null
  return { name, phone, email, company, fields, meta, selfConversion }
}

/**
 * Corpo do webhook → lista de leads. Aceita `{leads:[…]}`, `{lead:{…}}`,
 * um array solto ou um lead solto — o RD já avisou que o formato vai mudar.
 */
export function parseRdWebhook(body: unknown): RdLead[] {
  const raw: unknown[] = Array.isArray(body)
    ? body
    : isBag(body)
      ? Array.isArray(body.leads)
        ? body.leads
        : isBag(body.lead)
          ? [body.lead]
          : [body]
      : []
  return raw.map(mapRdLead).filter((l): l is RdLead => !!l)
}

/**
 * Identificador da conversão — vira a origem do lead no card do funil e decide
 * a abertura. A conversão sintética do RD CRM ("Negociação criada no RD
 * Station CRM", "Tarefa criada…") não conta: ela diria "franquia" pra um
 * pedido de orçamento. O `mapRdLead` já não a põe em `meta`; o filtro aqui
 * fica pra quem montar o lead por outro caminho.
 */
export function rdOriginLabel(lead: FetchedLead): string {
  const last = lead.meta['Última conversão']
  const first = lead.meta['Primeira conversão']
  return (
    [last, first].find((c) => c && !isSyntheticConversion(c)) || first || last || 'RD Station'
  )
}

export interface IntroChoice {
  /** Texto de abertura (pode ter partes separadas por uma linha "---"). */
  text: string | null
  /** Template da Meta pra esse tipo de lead; null = não usar template. */
  templateName: string | null
  /**
   * Número que abre ESTE tipo de lead; null = o da fonte. Zelo 18/09: franquia
   * volta pro oficial (tem template aprovado), mas orçamento/vaga ainda não
   * têm — seguem pelo número de recados até a Meta aprovar os modelos.
   */
  channelId: string | null
  /**
   * Cadência de quem não responde a ESTA abertura; null = nenhuma. Zelo: só a
   * de franquia (padrão da fonte, `introCadenceId`) — orçamento/vaga vão pra
   * pessoa, não pra nutrição de franquia.
   */
  cadenceId: string | null
  /**
   * Número RESERVA, usado só enquanto o modelo desta abertura não está
   * APROVADO na Meta (aí o oficial não alcança lead novo). Zelo 18/09: tudo
   * pelo oficial; orçamento/vaga caem no número de recados só até a Meta
   * aprovar `orcamento_recebido`/`vaga_recebida` — aprovou, vira oficial sozinho.
   */
  fallbackChannelId: string | null
}

/** Como a abertura sai de fato: pelo canal da regra com o modelo, ou — se o
 *  modelo ainda não está aprovado e há número reserva — pela reserva, em texto. */
export function introDelivery(
  intro: IntroChoice,
  templateApproved: boolean,
): { channelId: string | null; templateName: string | null; text: string | null; usedFallback: boolean } {
  if (intro.templateName && !templateApproved && intro.fallbackChannelId) {
    return { channelId: intro.fallbackChannelId, templateName: null, text: intro.text, usedFallback: true }
  }
  return { channelId: intro.channelId, templateName: intro.templateName, text: intro.text, usedFallback: false }
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
        channelId: typeof r.channelId === 'string' && r.channelId.trim() ? r.channelId.trim() : null,
        cadenceId: typeof r.cadenceId === 'string' && r.cadenceId.trim() ? r.cadenceId.trim() : null,
        fallbackChannelId:
          typeof r.fallbackChannelId === 'string' && r.fallbackChannelId.trim() ? r.fallbackChannelId.trim() : null,
      }
    }
  }
  return {
    text: typeof meta.introText === 'string' && meta.introText.trim() ? meta.introText.trim() : null,
    templateName:
      typeof meta.introTemplateName === 'string' && meta.introTemplateName.trim()
        ? meta.introTemplateName.trim()
        : null,
    channelId: null,
    cadenceId:
      typeof meta.introCadenceId === 'string' && meta.introCadenceId.trim() ? meta.introCadenceId.trim() : null,
    fallbackChannelId:
      typeof meta.introFallbackChannelId === 'string' && meta.introFallbackChannelId.trim()
        ? meta.introFallbackChannelId.trim()
        : null,
  }
}
