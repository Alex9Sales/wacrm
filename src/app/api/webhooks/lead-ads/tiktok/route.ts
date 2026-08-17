// ============================================================
// Webhook do TikTok Lead Ads (Lead Generation).
//   • GET  — verificação: ecoa qualquer challenge (challenge/echo/hub.challenge)
//            e, na falta, responde 200 (alguns setups do TikTok só checam 200).
//   • POST — recebe o evento de lead, roteia por advertiser_id, valida a
//            assinatura (se houver secret) e ingere o lead (usa os campos inline
//            do webhook ou busca na API → contato + card).
//
// ⚠️ PILOTO: o formato do TikTok varia por versão; o provider é tolerante e os
// TODOs marcam o que confirmar com o 1º payload real.
// ============================================================

import { NextResponse, after } from 'next/server'

import {
  parseTikTokLeadEvents,
  verifyTikTokSignature,
  resolveTikTokLead,
} from '@/lib/leads/providers/tiktok'
import { loadLeadSourceForWebhook } from '@/lib/leads/sources'
import { ingestFetchedLead } from '@/lib/leads/engine'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const challenge =
    searchParams.get('challenge') ||
    searchParams.get('echo') ||
    searchParams.get('hub.challenge')
  if (challenge) {
    return new Response(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })
  }
  return NextResponse.json({ status: 'ok' }, { status: 200 })
}

export async function POST(request: Request) {
  const rawBody = await request.text()

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const events = parseTikTokLeadEvents(body)
  if (events.length === 0) {
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  // Roteia pela 1ª fonte casada; dela tiramos o app secret p/ a assinatura.
  const first = await loadLeadSourceForWebhook('tiktok', events[0].advertiserId, events[0].formId)
  const appSecret =
    (first && typeof first.providerMeta.appSecret === 'string'
      ? (first.providerMeta.appSecret as string)
      : null) || process.env.TIKTOK_APP_SECRET || null

  // Se há secret configurado, EXIGE assinatura válida. Sem secret (piloto),
  // segue com aviso — o dado inline/busca é o portão até fixarmos o esquema.
  const sig =
    request.headers.get('x-tt-signature') ||
    request.headers.get('x-tiktok-signature') ||
    request.headers.get('x-signature')
  if (appSecret) {
    if (!verifyTikTokSignature(rawBody, sig, appSecret)) {
      console.warn('[lead-ads/tiktok] rejected request with invalid signature')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  } else {
    console.warn(
      '[lead-ads/tiktok] sem app secret (TIKTOK_APP_SECRET nem por-fonte) — ' +
        'processando SEM validar assinatura (piloto). Configure o secret p/ fechar.',
    )
  }

  after(async () => {
    for (const ev of events) {
      try {
        const source = await loadLeadSourceForWebhook('tiktok', ev.advertiserId, ev.formId)
        if (!source) {
          console.warn('[lead-ads/tiktok] no source for advertiser', ev.advertiserId)
          continue
        }
        const lead = await resolveTikTokLead(source, ev)
        if (!lead) continue
        await ingestFetchedLead(source, lead)
      } catch (err) {
        console.error('[lead-ads/tiktok] process error:', err)
      }
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
