// ============================================================
// Callback do OAuth "Conectar Instagram". O Instagram redireciona aqui com
// ?code=&state=. Trocamos o code por token (short → long-lived), pegamos o id +
// @username da conta e criamos (ou atualizamos) o canal Instagram da conta —
// tudo pronto pra receber/responder DM. Sem colar token na mão.
//
// Precisa de env: INSTAGRAM_APP_SECRET (secret do app do Instagram). O app id
// (público) e o redirect têm default.
// ============================================================

import { NextResponse } from 'next/server'
import { and, eq, sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'

import { db, channels } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { createChannel } from '@/lib/channels/channels'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const IG_APP_ID = process.env.INSTAGRAM_APP_ID || '1040945168862432'
const APP_SECRET = process.env.INSTAGRAM_APP_SECRET || ''
const REDIRECT =
  process.env.INSTAGRAM_OAUTH_REDIRECT ||
  'https://crm.salestecnologia.com.br/api/instagram/oauth/callback'
const APP_URL = process.env.APP_URL || 'https://crm.salestecnologia.com.br'
const GRAPH_BASE = 'https://graph.instagram.com/v21.0'

function back(status: string): NextResponse {
  return NextResponse.redirect(`${APP_URL}/settings?ig=${encodeURIComponent(status)}`)
}

/**
 * Inscreve a conta IG no webhook do app (messages + comments). SEM isso o
 * Instagram não entrega os DMs/comentários da conta — era o passo manual que
 * a Fluxia teve e as conexões por OAuth não tinham. Best-effort.
 */
async function subscribeInstagram(igId: string, token: string): Promise<void> {
  try {
    const res = await fetch(
      `${GRAPH_BASE}/${igId}/subscribed_apps?subscribed_fields=messages,comments&access_token=${encodeURIComponent(
        token,
      )}`,
      { method: 'POST' },
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn('[instagram oauth] subscribe falhou', igId, res.status, body)
    } else {
      console.log('[instagram oauth] webhook inscrito', igId)
    }
  } catch (err) {
    console.warn('[instagram oauth] subscribe erro', igId, err)
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const err = searchParams.get('error_description') || searchParams.get('error')
  if (err) return back('erro')
  if (!code || !state) return back('erro')
  if (!APP_SECRET) {
    console.error('[instagram oauth] INSTAGRAM_APP_SECRET não configurado')
    return back('sem_secret')
  }

  // Valida o state (conta + usuário + timestamp).
  let payload: { a?: string; u?: string; t?: number }
  try {
    payload = JSON.parse(decrypt(state))
  } catch {
    return back('erro')
  }
  if (!payload.a || !payload.t || Date.now() - payload.t > 10 * 60 * 1000) {
    return back('expirado')
  }
  const accountId = payload.a

  try {
    // 1) code → token de curta duração (+ user_id).
    const form = new URLSearchParams({
      client_id: IG_APP_ID,
      client_secret: APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT,
      code,
    })
    const shortRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    })
    const short = (await shortRes.json().catch(() => ({}))) as {
      access_token?: string
      user_id?: string | number
      error_message?: string
    }
    if (!shortRes.ok || !short.access_token) {
      console.error('[instagram oauth] short token falhou:', short.error_message)
      return back('erro')
    }

    // 2) token de curta → longa duração (60 dias).
    let token = short.access_token
    try {
      const longRes = await fetch(
        `${GRAPH_BASE}/access_token?grant_type=ig_exchange_token&client_secret=${APP_SECRET}&access_token=${short.access_token}`,
      )
      const long = (await longRes.json().catch(() => ({}))) as {
        access_token?: string
      }
      if (long.access_token) token = long.access_token
    } catch {
      /* fica com o de curta duração */
    }

    // 3) id + @username da conta.
    let igId = short.user_id ? String(short.user_id) : ''
    let username = ''
    try {
      const meRes = await fetch(
        `${GRAPH_BASE}/me?fields=user_id,username&access_token=${token}`,
      )
      const me = (await meRes.json().catch(() => ({}))) as {
        user_id?: string
        username?: string
      }
      if (me.user_id) igId = me.user_id
      if (me.username) username = me.username
    } catch {
      /* best-effort */
    }
    if (!igId) return back('erro')

    const name = username ? `Instagram @${username}` : 'Instagram Direct'
    const providerMeta = { ig_id: igId, graphBase: GRAPH_BASE }
    const credentials = {
      accessToken: token,
      appSecret: APP_SECRET,
      verifyToken: randomBytes(12).toString('hex'),
    }

    // 4) Se já existe canal pra esse ig_id, ATUALIZA (reconecta); senão cria.
    const existing = firstOrNull(
      await db
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.provider, 'instagram'),
            sql`${channels.providerMeta}->>'ig_id' = ${igId}`,
          ),
        )
        .limit(1),
    )
    if (existing) {
      await db
        .update(channels)
        .set({
          credentials: encrypt(JSON.stringify(credentials)),
          providerMeta,
          status: 'connected',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(channels.id, existing.id))
      await subscribeInstagram(igId, token)
      return back('reconectado')
    }

    await createChannel(accountId, {
      provider: 'instagram',
      name,
      status: 'connected',
      credentials,
      providerMeta,
    })
    await subscribeInstagram(igId, token)
    return back('ok')
  } catch (error) {
    console.error('[instagram oauth] callback error:', error)
    return back('erro')
  }
}
