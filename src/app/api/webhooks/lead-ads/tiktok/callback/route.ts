// ============================================================
// Callback do OAuth do TikTok (caminho guiado dos Anúncios de Lead).
// O TikTok redireciona pra cá com ?auth_code=&state=. Validamos o state
// (assinado, carrega o accountId), trocamos o code por access_token +
// advertiser_ids e gravamos/atualizamos uma fonte por conta de anúncios.
// ============================================================

import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db, leadAdSources } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  exchangeTikTokCode,
  parseTikTokState,
} from '@/lib/leads/providers/tiktok-oauth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const APP_URL = process.env.APP_URL || 'https://crm.salestecnologia.com.br'

function back(status: string) {
  return NextResponse.redirect(
    `${APP_URL}/settings?tab=lead-ads&tiktok=${encodeURIComponent(status)}`,
  )
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const authCode = searchParams.get('auth_code') || searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  if (error) {
    console.warn('[tiktok-oauth/callback] provider error:', error)
    return back('error')
  }
  if (!authCode) return back('error')

  const parsed = parseTikTokState(state)
  if (!parsed) {
    console.warn('[tiktok-oauth/callback] invalid/expired state')
    return back('error')
  }

  const token = await exchangeTikTokCode(authCode)
  if (!token) return back('error')

  const accountId = parsed.accountId
  const enc = encrypt(token.accessToken)
  const advertisers = token.advertiserIds.length ? token.advertiserIds : ['']

  try {
    for (const advId of advertisers) {
      const existing = firstOrNull(
        await db
          .select({ id: leadAdSources.id })
          .from(leadAdSources)
          .where(
            and(
              eq(leadAdSources.accountId, accountId),
              eq(leadAdSources.provider, 'tiktok'),
              eq(leadAdSources.externalAccountId, advId),
            ),
          )
          .limit(1),
      )
      if (existing) {
        await db
          .update(leadAdSources)
          .set({
            accessToken: enc,
            status: 'connected',
            enabled: true,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(leadAdSources.id, existing.id))
      } else {
        await db.insert(leadAdSources).values({
          accountId,
          provider: 'tiktok',
          name: advId ? `TikTok — ${advId}` : 'TikTok',
          status: 'connected',
          externalAccountId: advId || null,
          accessToken: enc,
          enabled: true,
          providerMeta: {},
        })
      }
    }
  } catch (err) {
    console.error('[tiktok-oauth/callback] persist error:', err)
    return back('error')
  }

  return back('connected')
}
