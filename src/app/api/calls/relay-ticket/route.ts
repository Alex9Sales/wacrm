// ============================================================
// POST /api/calls/relay-ticket — bilhete para o relay de áudio da IA de voz.
// Body: { callId, mode: 'listen' | 'talk' }
//
// O motor de chamadas não passa a ligação de um peer para outro (o `meowcaller`
// não implementa transferência nem aceita 2º peer), então quem quiser ouvir ou
// assumir uma ligação da IA não fala com o gows — fala com o BRIDGE, que é o
// dono do áudio. O bridge expõe um WebSocket e confere sozinho um bilhete
// assinado, sem precisar consultar o CRM no meio da ligação.
//
// Este endpoint é o guardião: valida a SESSÃO do atendente e que a ligação é da
// CONTA dele, e só então assina `callId.mode.exp` com o segredo que o bridge
// também tem. O modo entra na assinatura de propósito — senão um bilhete de
// escuta viraria um de fala só editando a URL.
//
// Validade curta (o navegador conecta na hora); a URL devolvida já vem pronta,
// no mesmo domínio do CRM (o Traefik faz o TLS e encaminha /voice-relay).
// ============================================================

import crypto from 'crypto'

import { NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'

import { db, callLogs } from '@/db'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

export const dynamic = 'force-dynamic'

/** Janela de vida do bilhete. Curta: é usado imediatamente. */
const TICKET_TTL_MS = 60_000

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = (await request.json().catch(() => ({}))) as {
      callId?: unknown
      mode?: unknown
    }
    const callId = typeof body.callId === 'string' ? body.callId : ''
    const mode = body.mode === 'talk' ? 'talk' : 'listen'
    if (!callId) {
      return NextResponse.json({ error: 'callId required' }, { status: 400 })
    }

    const secret = process.env.VOICE_BRIDGE_TOKEN
    if (!secret) {
      return NextResponse.json(
        { error: 'relay not configured' },
        { status: 503 },
      )
    }

    // A ligação tem que ser DESTA conta e ainda estar viva — sem isso, um
    // callId adivinhado viraria escuta de conversa alheia.
    const [row] = await db
      .select({ id: callLogs.id })
      .from(callLogs)
      .where(
        and(
          eq(callLogs.accountId, ctx.accountId),
          eq(callLogs.externalCallId, callId),
          isNull(callLogs.endedAt),
        ),
      )
      .limit(1)
    if (!row) {
      return NextResponse.json(
        { error: 'call not found or already ended' },
        { status: 404 },
      )
    }

    const exp = Date.now() + TICKET_TTL_MS
    const sig = crypto
      .createHmac('sha256', secret)
      .update(`${callId}.${mode}.${exp}`)
      .digest('hex')

    // Mesmo host do CRM: o Traefik termina o TLS e encaminha /voice-relay ao
    // bridge, então não há porta extra nem certificado próprio para manter.
    const host = new URL(request.url).host
    const url =
      `wss://${host}/voice-relay?callId=${encodeURIComponent(callId)}` +
      `&mode=${mode}&exp=${exp}&sig=${sig}`

    return NextResponse.json({ url, mode, exp })
  } catch (err) {
    return toErrorResponse(err)
  }
}
