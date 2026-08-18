// ============================================================
// Webhook do LinkedIn Lead Sync (leadNotifications).
//   • GET  — validação: responde ao desafio do LinkedIn
//            ({ challengeCode, challengeResponse:HMAC }); na falta, ecoa
//            challenge/echo ou responde 200.
//   • POST — recebe o evento de lead, roteia por organization id, valida a
//            assinatura (X-LI-Signature, se houver secret) e ingere o lead (usa
//            os campos inline do webhook ou busca em leadFormResponses → contato
//            + card no funil).
//
// ⚠️ PRONTO/PILOTO: o Lead Sync depende de aprovação do LinkedIn. O provider é
// tolerante e os TODOs marcam o que confirmar com o 1º payload real.
// ============================================================

import { NextResponse, after } from 'next/server'

import {
  parseLinkedInLeadEvents,
  verifyLinkedInSignature,
  linkedInChallengeResponse,
  resolveLinkedInLead,
} from '@/lib/leads/providers/linkedin'
import { loadLeadSourceForWebhook } from '@/lib/leads/sources'
import { ingestFetchedLead } from '@/lib/leads/engine'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)

  // Validação de URL do LinkedIn: ?challengeCode=&applicationId= → devolve o
  // challengeCode + o HMAC dele com o client secret do app.
  const challengeCode = searchParams.get('challengeCode')
  if (challengeCode) {
    const response = linkedInChallengeResponse(challengeCode)
    if (!response) {
      console.warn('[lead-ads/linkedin] challenge sem LINKEDIN_CLIENT_SECRET no ambiente')
      return NextResponse.json({ error: 'Not configured' }, { status: 500 })
    }
    return NextResponse.json(
      { challengeCode, challengeResponse: response },
      { status: 200 },
    )
  }

  // Fallbacks (challenge simples), caso o setup use outro esquema.
  const challenge =
    searchParams.get('challenge') || searchParams.get('echo') || searchParams.get('hub.challenge')
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

  const events = parseLinkedInLeadEvents(body)
  if (events.length === 0) {
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  // Roteia pela 1ª fonte casada; dela tiramos o app secret p/ a assinatura.
  const first = await loadLeadSourceForWebhook(
    'linkedin',
    events[0].organizationId,
    events[0].formId,
  )
  const appSecret =
    (first && typeof first.providerMeta.appSecret === 'string'
      ? (first.providerMeta.appSecret as string)
      : null) ||
    process.env.LINKEDIN_CLIENT_SECRET ||
    null

  // Se há secret configurado, EXIGE assinatura válida. Sem secret (piloto/teste),
  // segue com aviso — a busca com o token da fonte é o portão até fixarmos tudo.
  const sig =
    request.headers.get('x-li-signature') || request.headers.get('x-linkedin-signature')
  if (appSecret) {
    if (!verifyLinkedInSignature(rawBody, sig, appSecret)) {
      console.warn('[lead-ads/linkedin] rejected request with invalid signature')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  } else {
    console.warn(
      '[lead-ads/linkedin] sem client secret (LINKEDIN_CLIENT_SECRET nem por-fonte) — ' +
        'processando SEM validar assinatura (piloto). Configure o secret p/ fechar.',
    )
  }

  after(async () => {
    for (const ev of events) {
      try {
        const source = await loadLeadSourceForWebhook(
          'linkedin',
          ev.organizationId,
          ev.formId,
        )
        if (!source) {
          console.warn('[lead-ads/linkedin] no source for org', ev.organizationId)
          continue
        }
        const lead = await resolveLinkedInLead(source, ev)
        if (!lead) continue
        await ingestFetchedLead(source, lead)
      } catch (err) {
        console.error('[lead-ads/linkedin] process error:', err)
      }
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
