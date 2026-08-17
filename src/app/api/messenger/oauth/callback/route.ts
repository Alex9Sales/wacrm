// ============================================================
// Callback do OAuth "Conectar Messenger". O Facebook redireciona aqui com
// ?code=&state=. Trocamos o code por token de usuário (short → long-lived),
// listamos as Páginas do usuário e, pra cada uma, criamos (ou atualizamos) o
// canal Messenger + INSCREVEMOS a Página no webhook (subscribed_apps) — o
// passo que travava na conexão manual. Sem colar token na mão.
//
// Precisa de env: META_APP_SECRET. O app id (público) tem default.
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

const FB_APP_ID =
  process.env.NEXT_PUBLIC_META_APP_ID ||
  process.env.META_APP_ID ||
  '1920154046039310'
const APP_SECRET = process.env.META_APP_SECRET || ''
const REDIRECT =
  process.env.MESSENGER_OAUTH_REDIRECT ||
  'https://crm.salestecnologia.com.br/api/messenger/oauth/callback'
const APP_URL = process.env.APP_URL || 'https://crm.salestecnologia.com.br'
const GRAPH = 'https://graph.facebook.com/v21.0'

function back(status: string): NextResponse {
  return NextResponse.redirect(
    `${APP_URL}/settings?tab=channels&messenger=${encodeURIComponent(status)}`,
  )
}

interface FbPage {
  id: string
  name: string
  access_token: string
}

/** Inscreve a Página no app pro webhook de mensagens (o passo manual chato). */
async function subscribePage(pageId: string, pageToken: string): Promise<void> {
  try {
    const res = await fetch(
      `${GRAPH}/${pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks&access_token=${encodeURIComponent(
        pageToken,
      )}`,
      { method: 'POST' },
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn('[messenger oauth] subscribe falhou', pageId, res.status, body)
    }
  } catch (err) {
    console.warn('[messenger oauth] subscribe erro', pageId, err)
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
    console.error('[messenger oauth] META_APP_SECRET não configurado')
    return back('sem_secret')
  }

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
    // 1) code → token de usuário (curta duração).
    const shortRes = await fetch(
      `${GRAPH}/oauth/access_token?client_id=${FB_APP_ID}` +
        `&client_secret=${APP_SECRET}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&code=${encodeURIComponent(code)}`,
    )
    const short = (await shortRes.json().catch(() => ({}))) as {
      access_token?: string
      error?: { message?: string }
    }
    if (!shortRes.ok || !short.access_token) {
      console.error('[messenger oauth] short token falhou:', short.error?.message)
      return back('erro')
    }

    // 2) curta → longa duração (token de usuário de ~60 dias; as Page tokens
    //    derivadas dele não expiram).
    let userToken = short.access_token
    try {
      const longRes = await fetch(
        `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token` +
          `&client_id=${FB_APP_ID}&client_secret=${APP_SECRET}` +
          `&fb_exchange_token=${short.access_token}`,
      )
      const long = (await longRes.json().catch(() => ({}))) as {
        access_token?: string
      }
      if (long.access_token) userToken = long.access_token
    } catch {
      /* fica com o de curta duração */
    }

    // 3) Páginas do usuário (+ Page access token de cada).
    const pagesRes = await fetch(
      `${GRAPH}/me/accounts?fields=id,name,access_token&limit=100&access_token=${userToken}`,
    )
    const pagesJson = (await pagesRes.json().catch(() => ({}))) as {
      data?: FbPage[]
    }
    const pages = (pagesJson.data ?? []).filter((p) => p.id && p.access_token)
    if (pages.length === 0) return back('sem_pagina')

    // 4) Cria/atualiza um canal por Página + inscreve o webhook.
    let connected = 0
    for (const page of pages) {
      const providerMeta = { page_id: page.id }
      const credentials = {
        accessToken: page.access_token,
        appSecret: APP_SECRET,
        verifyToken: randomBytes(12).toString('hex'),
      }

      const existing = firstOrNull(
        await db
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(
              eq(channels.provider, 'messenger'),
              sql`${channels.providerMeta}->>'page_id' = ${page.id}`,
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
      } else {
        const baseName = `Messenger — ${page.name || page.id}`
        try {
          await createChannel(accountId, {
            provider: 'messenger',
            name: baseName,
            status: 'connected',
            credentials,
            providerMeta,
          })
        } catch {
          // conflito de nome (UNIQUE account_id+name) → desambigua com o page_id.
          await createChannel(accountId, {
            provider: 'messenger',
            name: `${baseName} (${page.id})`,
            status: 'connected',
            credentials,
            providerMeta,
          })
        }
      }

      await subscribePage(page.id, page.access_token)
      connected += 1
    }

    return back(String(connected))
  } catch (error) {
    console.error('[messenger oauth] callback error:', error)
    return back('erro')
  }
}
