// ============================================================
// Template da API oficial no disparo pela ETAPA do funil — o que o template
// pede ({{1}}, {{2}}…, cabeçalho, botão com link variável) e como cada lead
// preenche. PURO (client-safe): a tela valida e mostra a prévia com isto e o
// servidor monta os parâmetros de cada destinatário com a MESMA regra.
//
// 15/09 (GoLink): o disparo pela etapa só mandava texto pelo WhatsApp não
// oficial; agora segue os mesmos tipos dos Disparos (WhatsApp, e-mail e
// template). A Meta recusa variável vazia ("Parameter of type text is missing
// text value") — por isso campo do contato sem valor usa o "Se faltar" e,
// sem ele, o disparo nem é criado (diz quantos leads estão sem o campo).
// ============================================================

import type { MessageTemplate } from '@/types'
import { contactTokenValues, type ContactVars } from '@/lib/whatsapp/message-vars'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'

export type TemplateVarSource = 'first_name' | 'name' | 'phone' | 'email' | 'company' | 'static'

export const TEMPLATE_VAR_SOURCES: { value: TemplateVarSource; label: string }[] = [
  { value: 'static', label: 'Texto fixo' },
  { value: 'first_name', label: 'Primeiro nome' },
  { value: 'name', label: 'Nome' },
  { value: 'phone', label: 'Telefone' },
  { value: 'email', label: 'E-mail' },
  { value: 'company', label: 'Empresa' },
]

const SOURCE_TOKEN: Record<Exclude<TemplateVarSource, 'static'>, string> = {
  first_name: 'primeiro_nome',
  name: 'nome',
  phone: 'telefone',
  email: 'email',
  company: 'empresa',
}

const SOURCE_NOUN: Record<Exclude<TemplateVarSource, 'static'>, string> = {
  first_name: 'nome',
  name: 'nome',
  phone: 'telefone',
  email: 'e-mail',
  company: 'empresa',
}

export interface TemplateVarMapping {
  source: TemplateVarSource
  /** Texto fixo (source 'static') ou o "Se faltar" dos campos do contato. */
  value?: string
}

/** Tudo que o disparo de template leva além do nome do template. */
export interface TemplateSendMapping {
  /** "1" → o que vai em {{1}} do corpo. */
  variables: Record<string, TemplateVarMapping>
  /** {{1}} do cabeçalho de TEXTO, quando o cabeçalho tem variável. */
  headerVariable?: TemplateVarMapping | null
  /** Índice do botão (no array do template) → final do link ({{1}} da URL). */
  buttonValues?: Record<string, string>
  /** Arquivo do cabeçalho de imagem/vídeo/documento (URL pública). */
  headerMediaUrl?: string | null
}

export type TemplateHeaderMedia = 'image' | 'video' | 'document'

export interface TemplateNeeds {
  /** Variáveis do corpo, em ordem ({{1}}, {{2}}…). */
  bodyIndices: number[]
  /** Cabeçalho de texto com {{1}}. */
  headerText: boolean
  /** Cabeçalho de mídia (a Meta exige o arquivo em todo envio). */
  headerMedia: TemplateHeaderMedia | null
  /** Botões de link com {{1}} no fim da URL. */
  urlButtons: { index: number; text: string }[]
}

export type TemplateShape = Pick<MessageTemplate, 'body_text' | 'header_type' | 'header_content' | 'buttons'>

function variableIndices(text: string | null | undefined): number[] {
  const set = new Set<number>()
  for (const m of (text ?? '').matchAll(/\{\{(\d+)\}\}/g)) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n >= 1) set.add(n)
  }
  return [...set].sort((a, b) => a - b)
}

export function templateNeeds(t: TemplateShape): TemplateNeeds {
  const header = t.header_type ?? null
  return {
    bodyIndices: variableIndices(t.body_text),
    headerText: header === 'text' && variableIndices(t.header_content).length > 0,
    headerMedia: header === 'image' || header === 'video' || header === 'document' ? header : null,
    urlButtons: (t.buttons ?? []).flatMap((b, index) =>
      b.type === 'URL' && variableIndices(b.url).length > 0 ? [{ index, text: b.text }] : [],
    ),
  }
}

/** Mapeamento inicial ao escolher um template: tudo em branco (a pessoa escolhe). */
export function emptyTemplateMapping(
  needs: TemplateNeeds,
  template?: Pick<MessageTemplate, 'header_media_url'> | null,
): TemplateSendMapping {
  return {
    variables: Object.fromEntries(
      needs.bodyIndices.map((i) => [String(i), { source: 'static', value: '' } as TemplateVarMapping]),
    ),
    headerVariable: needs.headerText ? { source: 'static', value: '' } : null,
    buttonValues: {},
    headerMediaUrl: needs.headerMedia ? (template?.header_media_url ?? '') : null,
  }
}

/** Valor de UMA variável pra um contato ('' = ficou vazia). */
export function resolveTemplateVar(m: TemplateVarMapping | null | undefined, contact: ContactVars): string {
  if (!m) return ''
  const fallback = (m.value ?? '').trim()
  if (m.source === 'static') return fallback
  const token = SOURCE_TOKEN[m.source]
  if (!token) return ''
  return contactTokenValues(contact)[token] || fallback
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

const MEDIA_LABEL: Record<TemplateHeaderMedia, string> = {
  image: 'imagem',
  video: 'vídeo',
  document: 'documento',
}

/** Erro em PT do que falta preencher (independe dos leads); null = pronto. */
export function validateTemplateMapping(needs: TemplateNeeds, mapping: TemplateSendMapping): string | null {
  const check = (m: TemplateVarMapping | null | undefined, where: string): string | null => {
    if (!m || !TEMPLATE_VAR_SOURCES.some((s) => s.value === m.source)) {
      return `Escolha o que vai em ${where}.`
    }
    if (m.source === 'static' && !(m.value ?? '').trim()) return `Escreva o texto fixo de ${where}.`
    return null
  }
  if (needs.headerText) {
    const err = check(mapping.headerVariable, '{{1}} do cabeçalho')
    if (err) return err
  }
  for (const i of needs.bodyIndices) {
    const err = check(mapping.variables?.[String(i)], `{{${i}}}`)
    if (err) return err
  }
  if (needs.headerMedia) {
    const url = (mapping.headerMediaUrl ?? '').trim()
    if (!url) return `Este template tem ${MEDIA_LABEL[needs.headerMedia]} no cabeçalho: envie o arquivo.`
    if (!isHttpUrl(url)) return `O arquivo do cabeçalho não tem um link válido. Envie o arquivo de novo.`
  }
  for (const b of needs.urlButtons) {
    if (!(mapping.buttonValues?.[String(b.index)] ?? '').trim()) {
      return `Preencha o final do link do botão "${b.text}".`
    }
  }
  return null
}

export interface TemplateRecipientSend {
  /** Valores do corpo ({{1}}, {{2}}…) — viram broadcast_recipients.params. */
  params: string[]
  messageParams?: SendTimeParams
  /** Onde o valor ficou vazio pra este contato ('header' ou o índice do corpo). */
  missing: ('header' | number)[]
}

/** Parâmetros de UM destinatário, com a mesma regra da prévia. */
export function buildTemplateRecipientSend(
  needs: TemplateNeeds,
  mapping: TemplateSendMapping,
  contact: ContactVars,
): TemplateRecipientSend {
  const missing: ('header' | number)[] = []
  const params = needs.bodyIndices.map((i) => {
    const v = resolveTemplateVar(mapping.variables?.[String(i)], contact)
    if (!v) missing.push(i)
    return v
  })
  const mp: SendTimeParams = {}
  if (needs.headerText) {
    const v = resolveTemplateVar(mapping.headerVariable, contact)
    if (!v) missing.push('header')
    mp.headerText = v
  }
  if (needs.headerMedia) {
    const url = (mapping.headerMediaUrl ?? '').trim()
    if (url) mp.headerMediaUrl = url
  }
  if (needs.urlButtons.length > 0) {
    const bp: Record<number, string> = {}
    for (const b of needs.urlButtons) bp[b.index] = (mapping.buttonValues?.[String(b.index)] ?? '').trim()
    mp.buttonParams = bp
  }
  return { params, messageParams: Object.keys(mp).length > 0 ? mp : undefined, missing }
}

/**
 * Erro quando há leads sem o campo escolhido e sem "Se faltar".
 * `counts`: onde faltou → quantos leads.
 */
export function missingValuesError(
  mapping: TemplateSendMapping,
  counts: Map<'header' | number, number>,
): string | null {
  for (const [where, n] of counts) {
    if (n <= 0) continue
    const m = where === 'header' ? mapping.headerVariable : mapping.variables?.[String(where)]
    const noun = m && m.source !== 'static' ? SOURCE_NOUN[m.source] : 'valor'
    const label = where === 'header' ? '{{1}} do cabeçalho' : `{{${where}}}`
    const leads = n === 1 ? '1 lead está' : `${n} leads estão`
    // Primeiro nome só conta quando parece de pessoa: "Google Ads", "+55…" e
    // siglas contam como faltando — sem isso o dono abre o lead, vê o nome
    // preenchido e não entende o bloqueio.
    const why =
      m?.source === 'first_name' ? ' usável (nome de empresa, número ou sigla não serve)' : ''
    return `${leads} sem ${noun}${why} pra ${label}. Preencha o "Se faltar" ou escolha outro campo.`
  }
  return null
}

/** Texto com as variáveis trocadas pelos valores do contato ({{n}} fica quando vazio). */
export function renderTemplateText(
  text: string | null | undefined,
  resolve: (index: number) => string,
): string {
  return (text ?? '').replace(/\{\{(\d+)\}\}/g, (match, raw: string) => resolve(Number(raw)) || match)
}

/** Prévia do corpo e do cabeçalho de texto pra um contato de exemplo. */
export function previewTemplate(
  t: TemplateShape & Pick<MessageTemplate, 'footer_text'>,
  mapping: TemplateSendMapping,
  contact: ContactVars,
): { header: string | null; body: string; footer: string | null } {
  return {
    header:
      t.header_type === 'text' && t.header_content
        ? renderTemplateText(t.header_content, () => resolveTemplateVar(mapping.headerVariable, contact))
        : null,
    body: renderTemplateText(t.body_text, (i) => resolveTemplateVar(mapping.variables?.[String(i)], contact)),
    footer: t.footer_text?.trim() || null,
  }
}
