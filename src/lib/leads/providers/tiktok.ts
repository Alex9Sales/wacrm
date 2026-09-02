// ============================================================
// TikTok Lead Ads (Lead Generation) — verificação, parse e busca do lead.
//
// ⚠️ PILOTO: o formato exato do webhook/da assinatura do TikTok varia por
// versão da Marketing API. Este provider é TOLERANTE de propósito:
//   • se o webhook já traz os campos do lead (field_data/fields inline), usa
//     direto — não precisa buscar;
//   • senão, busca no endpoint de Lead Generation com o Access-Token da fonte.
// Ao ver o 1º payload real, a gente ajusta o mapeamento (os TODOs marcam onde).
// Roteia por advertiser_id (external_account_id da fonte).
// ============================================================

import crypto from 'node:crypto'
import { restrictBase } from '@/lib/net/safe-url'

import type { LoadedLeadSource } from '@/lib/leads/sources'
import {
  type FetchedLead,
  mapContactFields,
  str,
} from '@/lib/leads/providers/shared'

const DEFAULT_BASE = 'https://business-api.tiktok.com'

export interface TikTokLeadEvent {
  advertiserId: string
  leadId: string
  formId: string | null
  pageId: string | null
  /** Campos já entregues no webhook (quando houver) — evita a busca. */
  inlineFields: Record<string, string> | null
}

/**
 * Assinatura do webhook (HMAC-SHA256 do corpo cru com o app secret). Aceita o
 * hex puro ou com prefixo `sha256=`. Retorna true se casar.
 */
export function verifyTikTokSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret?: string | null,
): boolean {
  const secret = appSecret || process.env.TIKTOK_APP_SECRET
  if (!secret || !signatureHeader) return false
  const provided = signatureHeader.replace(/^sha256=/i, '').trim()
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')
  try {
    const a = Buffer.from(provided, 'hex')
    const b = Buffer.from(expected, 'hex')
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** Normaliza uma lista field_data ([{name,values}]) OU um objeto {k:v}. */
function normalizeFields(raw: unknown): Record<string, string> | null {
  if (!raw) return null
  const map: Record<string, string> = {}
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const f = item as { name?: string; field_name?: string; values?: unknown; value?: unknown }
      const name = str(f.name) || str(f.field_name)
      if (!name) continue
      const value = Array.isArray(f.values)
        ? f.values.map(str).filter(Boolean).join(', ')
        : str(f.value ?? f.values)
      map[name.toLowerCase()] = value
    }
  } else if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      map[k.toLowerCase()] = str(v)
    }
  }
  return Object.keys(map).length ? map : null
}

/** Extrai os eventos de lead do corpo do webhook (tolerante a formatos). */
export function parseTikTokLeadEvents(body: unknown): TikTokLeadEvent[] {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return []

  // O payload pode vir num objeto único ou numa lista (data[] / events[]).
  const containers: Record<string, unknown>[] = []
  const listy = (b.data ?? b.events ?? b.records) as unknown
  if (Array.isArray(listy)) {
    for (const it of listy) if (it && typeof it === 'object') containers.push(it as Record<string, unknown>)
  }
  // Também trata o próprio corpo (e o b.data-objeto) como container.
  if (b.data && typeof b.data === 'object' && !Array.isArray(b.data)) {
    containers.push(b.data as Record<string, unknown>)
  }
  containers.push(b)

  const out: TikTokLeadEvent[] = []
  const seen = new Set<string>()
  for (const c of containers) {
    const advertiserId =
      str(c.advertiser_id) || str(b.advertiser_id) || str(c.advertiserId)
    const leadId =
      str(c.lead_id) || str(c.leadgen_id) || str(c.lead_gen_id) || str(c.id)
    if (!advertiserId || !leadId) continue
    const key = `${advertiserId}:${leadId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      advertiserId,
      leadId,
      formId: str(c.form_id) || str(c.page_form_id) || null,
      pageId: str(c.page_id) || null,
      inlineFields:
        normalizeFields(c.field_data) ??
        normalizeFields(c.fields) ??
        normalizeFields((c.lead as Record<string, unknown> | undefined)?.field_data),
    })
  }
  return out
}

/** true se o corpo parece um evento de lead do TikTok (roteador do webhook). */
export function hasTikTokLeadEvents(body: unknown): boolean {
  return parseTikTokLeadEvents(body).length > 0
}

/**
 * Resolve os campos do lead: usa os inline se vierem, senão busca na API.
 * ⚠️ endpoint de busca é PILOTO — confirmar com a doc/versão do TikTok.
 */
export async function resolveTikTokLead(
  source: LoadedLeadSource,
  ev: TikTokLeadEvent,
): Promise<FetchedLead | null> {
  let fieldMap = ev.inlineFields
  const meta: Record<string, string> = {}

  if (!fieldMap) {
    // 🛡️ Base só no host oficial (auditoria 02/09).
    const base = restrictBase(source.providerMeta.apiBase, DEFAULT_BASE, ['business-api.tiktok.com', 'tiktok.com'])
    // Endpoint de Lead Generation. Confirmado nos escopos do app (Lead
    // Management → /lead/get/). Sobrescrevível por provider_meta.leadEndpoint
    // se a versão exigir outro caminho (ex.: /page/lead/task/download/).
    const path =
      (typeof source.providerMeta.leadEndpoint === 'string' &&
        source.providerMeta.leadEndpoint) ||
      '/open_api/v1.3/lead/get/'
    const url = `${base}${path}?advertiser_id=${encodeURIComponent(
      ev.advertiserId,
    )}&lead_id=${encodeURIComponent(ev.leadId)}`
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Access-Token': source.accessToken },
      })
      const json = (await res.json()) as {
        code?: number
        message?: string
        data?: Record<string, unknown>
      }
      if (!res.ok || (typeof json.code === 'number' && json.code !== 0)) {
        console.error('[tiktok-lead] fetch failed', res.status, json?.message, json)
        return null
      }
      const d = json.data ?? {}
      fieldMap =
        normalizeFields(d.field_data) ??
        normalizeFields(d.fields) ??
        normalizeFields((d.lead as Record<string, unknown> | undefined)?.field_data) ??
        normalizeFields(d)
    } catch (err) {
      console.error('[tiktok-lead] fetch error', err)
      return null
    }
  }

  if (!fieldMap) {
    console.error('[tiktok-lead] no field data resolved for lead', ev.leadId)
    return null
  }

  return { ...mapContactFields(fieldMap), fields: fieldMap, meta }
}
