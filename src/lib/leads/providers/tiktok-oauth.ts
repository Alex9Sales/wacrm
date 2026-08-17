// ============================================================
// OAuth do TikTok (Marketing API) para conectar a conta de anúncios do cliente
// em 1 clique — o "caminho guiado" dos Anúncios de Lead.
//
// Fluxo: admin clica "Conectar TikTok" → mandamos pro portal de auth do TikTok
// com um `state` assinado (carrega o accountId) → o cliente autoriza → o TikTok
// volta pro nosso callback com `auth_code` → trocamos por um access_token +
// a lista de advertiser_ids → gravamos as fontes. O App ID/Secret vêm de env
// (só depois que o app do TikTok for aprovado).
// ============================================================

import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

const AUTH_BASE = 'https://business-api.tiktok.com/portal/auth'
const TOKEN_URL =
  'https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/'

/** Precisa casar EXATAMENTE o "Advertiser redirect URL" cadastrado no app. */
export const TIKTOK_REDIRECT_URI =
  'https://crm.salestecnologia.com.br/api/webhooks/lead-ads/tiktok/callback'

/** true quando as credenciais do app do TikTok estão no ambiente. */
export function tiktokConfigured(): boolean {
  return !!(process.env.TIKTOK_APP_ID && process.env.TIKTOK_APP_SECRET)
}

/** Monta a URL de autorização com um `state` assinado (carrega o accountId). */
export function buildTikTokAuthUrl(accountId: string): string {
  const appId = process.env.TIKTOK_APP_ID
  if (!appId) {
    throw new Error(
      'Conexão 1-clique do TikTok ainda não configurada (app em análise). ' +
        'Use a conexão manual por enquanto.',
    )
  }
  const state = encrypt(JSON.stringify({ a: accountId, t: Date.now() }))
  const url = new URL(AUTH_BASE)
  url.searchParams.set('app_id', appId)
  url.searchParams.set('state', state)
  url.searchParams.set('redirect_uri', TIKTOK_REDIRECT_URI)
  return url.toString()
}

/** Valida o `state` (assinado + fresco) e devolve o accountId. */
export function parseTikTokState(
  state: string | null,
  maxAgeMs = 15 * 60 * 1000,
): { accountId: string } | null {
  if (!state) return null
  try {
    const obj = JSON.parse(decrypt(state)) as { a?: string; t?: number }
    if (!obj.a || !obj.t) return null
    if (Date.now() - obj.t > maxAgeMs) return null
    return { accountId: obj.a }
  } catch {
    return null
  }
}

export interface TikTokToken {
  accessToken: string
  advertiserIds: string[]
}

/** Troca o auth_code por access_token + advertiser_ids. */
export async function exchangeTikTokCode(
  authCode: string,
): Promise<TikTokToken | null> {
  const app_id = process.env.TIKTOK_APP_ID
  const secret = process.env.TIKTOK_APP_SECRET
  if (!app_id || !secret) return null
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id, secret, auth_code: authCode }),
    })
    const json = (await res.json()) as {
      code?: number
      message?: string
      data?: { access_token?: string; advertiser_ids?: string[] }
    }
    if (json.code !== 0 || !json.data?.access_token) {
      console.error('[tiktok-oauth] token exchange failed', json?.code, json?.message)
      return null
    }
    return {
      accessToken: json.data.access_token,
      advertiserIds: json.data.advertiser_ids ?? [],
    }
  } catch (err) {
    console.error('[tiktok-oauth] exchange error', err)
    return null
  }
}
