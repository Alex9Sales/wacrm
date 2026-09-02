// ============================================================
// Meta Lead Ads (Facebook/Instagram) — verificação, parse e busca do lead.
//
// O webhook do Meta (object:'page', campo 'leadgen') só avisa o `leadgen_id`;
// os dados do formulário a gente BUSCA na Graph API com o token da Página. Por
// isso a busca é o verdadeiro portão: um webhook forjado não consegue inventar
// um leadgen_id real nem ler o field_data sem o nosso token.
// ============================================================

import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { restrictBase } from '@/lib/net/safe-url'
import type { LoadedLeadSource } from '@/lib/leads/sources'
import {
  type FetchedLead,
  mapContactFields,
  str,
} from '@/lib/leads/providers/shared'

const DEFAULT_GRAPH = 'https://graph.facebook.com/v21.0'

export interface MetaLeadEvent {
  pageId: string
  formId: string | null
  leadgenId: string
  adId: string | null
  createdTime: number | null
}

/** Assinatura X-Hub-Signature-256 (HMAC do app secret). Reusa o canônico. */
export function verifyMetaLeadSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret?: string | null,
): boolean {
  return verifyMetaWebhookSignature(rawBody, signatureHeader, appSecret ?? null)
}

/** Extrai os eventos de leadgen do corpo (entry[].changes[] field 'leadgen'). */
export function parseMetaLeadEvents(body: unknown): MetaLeadEvent[] {
  const out: MetaLeadEvent[] = []
  const b = body as { object?: string; entry?: unknown[] } | null
  if (!b || !Array.isArray(b.entry)) return out
  for (const entryRaw of b.entry) {
    const entry = entryRaw as { id?: string; changes?: unknown[] }
    if (!Array.isArray(entry.changes)) continue
    for (const changeRaw of entry.changes) {
      const change = changeRaw as {
        field?: string
        value?: Record<string, unknown>
      }
      if (change.field !== 'leadgen' || !change.value) continue
      const v = change.value
      const leadgenId = str(v.leadgen_id)
      if (!leadgenId) continue
      out.push({
        pageId: str(v.page_id) || str(entry.id) || '',
        formId: str(v.form_id) || null,
        leadgenId,
        adId: str(v.ad_id) || null,
        createdTime:
          typeof v.created_time === 'number' ? v.created_time : null,
      })
    }
  }
  return out
}

/** true se o corpo tem QUALQUER change de leadgen (roteador do webhook). */
export function hasMetaLeadEvents(body: unknown): boolean {
  return parseMetaLeadEvents(body).length > 0
}

/** Busca os dados do lead na Graph API com o token da fonte. */
export async function fetchMetaLead(
  source: LoadedLeadSource,
  leadgenId: string,
): Promise<FetchedLead | null> {
  // 🛡️ Base só no host oficial (auditoria 02/09: provider_meta é do tenant).
  const graph = restrictBase(source.providerMeta.graphBase, DEFAULT_GRAPH, ['graph.facebook.com'])
  const fields =
    'field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,created_time'
  const url = `${graph}/${encodeURIComponent(
    leadgenId,
  )}?fields=${fields}&access_token=${encodeURIComponent(source.accessToken)}`

  let json: unknown
  try {
    const res = await fetch(url, { method: 'GET' })
    json = await res.json()
    if (!res.ok) {
      console.error('[meta-lead] fetch failed', res.status, json)
      return null
    }
  } catch (err) {
    console.error('[meta-lead] fetch error', err)
    return null
  }

  const data = json as {
    field_data?: { name?: string; values?: string[] }[]
    campaign_name?: string
    ad_name?: string
  }
  const fieldMap: Record<string, string> = {}
  for (const f of data.field_data ?? []) {
    if (!f?.name) continue
    fieldMap[f.name.toLowerCase()] = (f.values ?? []).join(', ')
  }

  const meta: Record<string, string> = {}
  if (data.campaign_name) meta['Campanha'] = data.campaign_name
  if (data.ad_name) meta['Anúncio'] = data.ad_name

  return { ...mapContactFields(fieldMap), fields: fieldMap, meta }
}
