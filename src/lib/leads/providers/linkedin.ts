// ============================================================
// LinkedIn Lead Sync API — verificação, parse e busca do lead.
//
// ⚠️ PRONTO/PILOTO: o acesso ao Lead Sync depende de aprovação do LinkedIn
// (Access Request Form enviado 18/08 — app FluxiaCRM Lead Sync 263957029). Até
// aprovar, o provider já fica de pé e é TOLERANTE de propósito:
//   • se o webhook (leadNotifications) já trouxer os campos do lead inline, usa
//     direto — dá pra testar o encanamento com um payload simulado agora;
//   • senão, busca a resposta no endpoint leadFormResponses com o token da fonte.
//
// Assinatura: HMAC-SHA256 do corpo cru com o CLIENT SECRET do app, mandado no
// header X-LI-Signature (base64). Validação de desafio (GET) responde o HMAC do
// challengeCode. Roteia por organization id (external_account_id da fonte = id
// numérico da organização dona do formulário). Ao ver o 1º payload real, a gente
// ajusta o mapeamento (os TODOs marcam onde).
// ============================================================

import crypto from 'node:crypto'
import { restrictBase } from '@/lib/net/safe-url'

import type { LoadedLeadSource } from '@/lib/leads/sources'
import {
  type FetchedLead,
  mapContactFields,
  str,
} from '@/lib/leads/providers/shared'

const DEFAULT_API = 'https://api.linkedin.com/rest'
// Versão da API (header LinkedIn-Version, formato YYYYMM). Sobrescrevível por
// provider_meta.apiVersion quando o LinkedIn avançar a versão.
const DEFAULT_VERSION = '202508'

export interface LinkedInLeadEvent {
  /** id numérico da organização dona do formulário — chave de roteamento. */
  organizationId: string
  /** id/URN da resposta do formulário (leadFormResponse). */
  leadId: string
  formId: string | null
  /** Campos já entregues no webhook (quando houver) — evita a busca. */
  inlineFields: Record<string, string> | null
}

/** Extrai o id numérico de uma URN tipo urn:li:organization:12345 → "12345". */
function urnId(v: unknown): string {
  const s = str(v)
  if (!s) return ''
  const m = s.match(/(\d+)(?!.*\d)/) // último grupo de dígitos da string
  return m ? m[1] : s
}

/** Compara duas strings em tempo constante (mesmo tamanho → timingSafeEqual). */
function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

/**
 * Assinatura do webhook (HMAC-SHA256 do corpo cru com o client secret do app).
 * O LinkedIn manda no header X-LI-Signature (base64). Aceitamos base64 OU hex
 * (com/sem prefixo sha256=) pra ser tolerante entre versões. Retorna true se casar.
 */
export function verifyLinkedInSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret?: string | null,
): boolean {
  const secret = appSecret || process.env.LINKEDIN_CLIENT_SECRET
  if (!secret || !signatureHeader) return false
  const provided = signatureHeader.replace(/^sha256=/i, '').trim()
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest()
  return (
    safeEq(provided, digest.toString('base64')) ||
    safeEq(provided, digest.toString('hex'))
  )
}

/**
 * Resposta ao desafio de validação do webhook (GET com ?challengeCode=). O
 * LinkedIn espera { challengeCode, challengeResponse }, onde a resposta é o
 * HMAC-SHA256 (hex) do challengeCode usando o client secret como chave.
 * Retorna null se não houver secret configurado.
 */
export function linkedInChallengeResponse(
  challengeCode: string,
  appSecret?: string | null,
): string | null {
  const secret = appSecret || process.env.LINKEDIN_CLIENT_SECRET
  if (!secret || !challengeCode) return null
  return crypto.createHmac('sha256', secret).update(challengeCode).digest('hex')
}

/** Puxa um texto de resposta de um objeto de answer do LinkedIn (aninhado). */
function answerText(ans: unknown): string {
  if (ans == null) return ''
  if (typeof ans === 'string' || typeof ans === 'number') return str(ans)
  if (Array.isArray(ans)) return ans.map(answerText).filter(Boolean).join(', ')
  const o = ans as Record<string, unknown>
  // formatos comuns: {answer}, {value}, {text}, ou answerDetails aninhado.
  const direct = str(o.answer) || str(o.value) || str(o.text)
  if (direct) return direct
  // O objeto pode ser o answerDetails aninhado OU já ser os próprios details.
  const details = (o.answerDetails ?? o.details ?? o) as Record<string, unknown>
  const tqa = (details.textQuestionAnswer as Record<string, unknown> | undefined)?.answer
  const mca = (details.multipleChoiceAnswer as Record<string, unknown> | undefined)?.value
  const nested =
    tqa ?? mca ?? (details !== o ? (details.answer ?? details.value) : undefined)
  return nested != null ? answerText(nested) : ''
}

/**
 * Normaliza os campos do lead pra um mapa {nome_minusculo: valor}. Tolerante:
 *  • lista de answers do LinkedIn ([{questionId/question/name, answer/answerDetails}]);
 *  • lista genérica field_data ([{name, values|value}]);
 *  • objeto simples {k: v}.
 */
function normalizeFields(raw: unknown): Record<string, string> | null {
  if (!raw) return null
  const map: Record<string, string> = {}
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const f = item as Record<string, unknown>
      const name =
        str(f.name) ||
        str(f.question) ||
        str(f.questionId) ||
        str(f.field_name)
      if (!name) continue
      const value = Array.isArray(f.values)
        ? f.values.map(str).filter(Boolean).join(', ')
        : answerText(f.answer ?? f.answerDetails ?? f.value ?? f.values)
      if (value) map[name.toLowerCase()] = value
    }
  } else if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const value = answerText(v)
      if (value) map[k.toLowerCase()] = value
    }
  }
  return Object.keys(map).length ? map : null
}

/** Extrai os eventos de lead do corpo do webhook (tolerante a formatos). */
export function parseLinkedInLeadEvents(body: unknown): LinkedInLeadEvent[] {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return []

  // O payload pode vir num objeto único ou numa lista (elements/data/events).
  const containers: Record<string, unknown>[] = []
  const listy = (b.elements ?? b.data ?? b.events ?? b.records) as unknown
  if (Array.isArray(listy)) {
    for (const it of listy) {
      if (it && typeof it === 'object') containers.push(it as Record<string, unknown>)
    }
  }
  containers.push(b)

  const out: LinkedInLeadEvent[] = []
  const seen = new Set<string>()
  for (const c of containers) {
    const organizationId =
      urnId(c.owner) ||
      urnId(c.organization) ||
      urnId(c.account) ||
      urnId(b.owner) ||
      urnId(b.organization)
    const leadId =
      str(c.leadFormResponse) ||
      str(c.versionedLeadGenFormResponse) ||
      str(c.leadGenFormResponse) ||
      str(c.lead_id) ||
      str(c.leadId) ||
      str(c.id)
    if (!organizationId || !leadId) continue
    const key = `${organizationId}:${leadId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      organizationId,
      leadId,
      formId: str(c.form) || str(c.formId) || str(c.leadGenForm) || null,
      inlineFields:
        normalizeFields(c.answers) ??
        normalizeFields(c.field_data) ??
        normalizeFields(c.fields) ??
        normalizeFields(
          (c.formResponse as Record<string, unknown> | undefined)?.answers,
        ),
    })
  }
  return out
}

/** true se o corpo parece um evento de lead do LinkedIn (roteador do webhook). */
export function hasLinkedInLeadEvents(body: unknown): boolean {
  return parseLinkedInLeadEvents(body).length > 0
}

/**
 * Resolve os campos do lead: usa os inline se vierem, senão busca a resposta no
 * endpoint leadFormResponses com o token (Bearer) da fonte.
 * ⚠️ endpoint/headers são PILOTO — confirmar com a versão da API ao aprovar.
 */
export async function resolveLinkedInLead(
  source: LoadedLeadSource,
  ev: LinkedInLeadEvent,
): Promise<FetchedLead | null> {
  let fieldMap = ev.inlineFields
  const meta: Record<string, string> = {}

  if (!fieldMap) {
    // 🛡️ Base só no host oficial (auditoria 02/09).
    const base = restrictBase(source.providerMeta.apiBase, DEFAULT_API, ['api.linkedin.com', 'linkedin.com'])
    const version =
      (typeof source.providerMeta.apiVersion === 'string' &&
        source.providerMeta.apiVersion) ||
      DEFAULT_VERSION
    // O leadId pode ser id puro ou URN — a API aceita o id na rota REST.
    const id = encodeURIComponent(ev.leadId)
    const url = `${base}/leadFormResponses/${id}`
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${source.accessToken}`,
          'LinkedIn-Version': version,
          'X-Restli-Protocol-Version': '2.0.0',
        },
      })
      const json = (await res.json()) as Record<string, unknown>
      if (!res.ok) {
        console.error('[linkedin-lead] fetch failed', res.status, json)
        return null
      }
      const fr = (json.formResponse ?? json) as Record<string, unknown>
      fieldMap =
        normalizeFields(fr.answers) ??
        normalizeFields(json.answers) ??
        normalizeFields(json.field_data) ??
        normalizeFields(json)
      // Metadados úteis pro card, quando vierem.
      const campaign = str(json.campaign) || str(json.sponsoredCampaign)
      if (campaign) meta['Campanha'] = campaign
    } catch (err) {
      console.error('[linkedin-lead] fetch error', err)
      return null
    }
  }

  if (!fieldMap) {
    console.error('[linkedin-lead] no field data resolved for lead', ev.leadId)
    return null
  }

  return { ...mapContactFields(fieldMap), fields: fieldMap, meta }
}
