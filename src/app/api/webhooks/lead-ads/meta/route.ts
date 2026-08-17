// ============================================================
// Webhook do Meta Lead Ads (Facebook/Instagram — campo 'leadgen').
//   • GET  — verificação (hub.mode/hub.verify_token/hub.challenge). Casa o
//            verify_token de uma fonte Meta ou a env META_LEADS_VERIFY_TOKEN.
//   • POST — recebe entry[].changes[] field 'leadgen', roteia por page_id +
//            form_id, valida a assinatura (app secret) e ingere o lead
//            (busca o field_data com o token da Página → contato + card).
//
// Obs.: se a MESMA app do Meta já usa o Messenger, o callback da Página é único
// — nesse caso o leadgen chega junto no /api/webhooks/messenger. Para o piloto,
// aponte o campo 'leadgen' para ESTA rota (app dedicada ou sem Messenger).
// ============================================================

import { NextResponse, after } from 'next/server'

import {
  parseMetaLeadEvents,
  verifyMetaLeadSignature,
  fetchMetaLead,
} from '@/lib/leads/providers/meta'
import { loadLeadSourceForWebhook, metaVerifyTokenMatches } from '@/lib/leads/sources'
import { ingestFetchedLead } from '@/lib/leads/engine'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const challenge = searchParams.get('hub.challenge')
  const verifyToken = searchParams.get('hub.verify_token')

  if (mode !== 'subscribe' || !challenge || !verifyToken) {
    return NextResponse.json({ error: 'Missing verification parameters' }, { status: 400 })
  }

  const envToken = process.env.META_LEADS_VERIFY_TOKEN
  const ok =
    (envToken && verifyToken === envToken) ||
    (await metaVerifyTokenMatches(verifyToken))
  if (ok) {
    return new Response(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })
  }
  return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 })
}

export async function POST(request: Request) {
  const rawBody = await request.text()

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const events = parseMetaLeadEvents(body)
  if (events.length === 0) {
    // Não é um evento de leadgen (ex.: outro campo da Página) — ignora.
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  // Assinatura: usa o app secret da 1ª fonte casada (ou a env META_APP_SECRET).
  const first = await loadLeadSourceForWebhook('meta', events[0].pageId, events[0].formId)
  const appSecret =
    first && typeof first.providerMeta.appSecret === 'string'
      ? (first.providerMeta.appSecret as string)
      : null
  const sig = request.headers.get('x-hub-signature-256')
  if (!verifyMetaLeadSignature(rawBody, sig, appSecret)) {
    console.warn('[lead-ads/meta] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  after(async () => {
    for (const ev of events) {
      try {
        const source = await loadLeadSourceForWebhook('meta', ev.pageId, ev.formId)
        if (!source) {
          console.warn('[lead-ads/meta] no source for page', ev.pageId)
          continue
        }
        const lead = await fetchMetaLead(source, ev.leadgenId)
        if (!lead) continue
        await ingestFetchedLead(source, lead)
      } catch (err) {
        console.error('[lead-ads/meta] process error:', err)
      }
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
