// ============================================================
// OAuth do LinkedIn (Marketing API) para conectar a organização do cliente em
// 1 clique — o "caminho guiado" dos Anúncios de Lead do LinkedIn.
//
// Fluxo: admin clica "Conectar LinkedIn" → mandamos pro authorization do LinkedIn
// com um `state` assinado (carrega o accountId) + escopo r_marketing_leadgen_automation
// → o cliente autoriza → o LinkedIn volta pro nosso callback com `code` → trocamos
// por um access_token → gravamos a fonte (e descobrimos as organizações admin,
// best-effort). Client ID/Secret vêm de env (só depois que o Lead Sync for aprovado).
// ============================================================

import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

const AUTH_BASE = 'https://www.linkedin.com/oauth/v2/authorization'
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken'
const API_BASE = 'https://api.linkedin.com/rest'

// Escopos do Lead Sync. r_organization_admin permite LISTAR as organizações que
// o usuário administra no callback → o organization id preenche SOZINHO (o
// cliente não digita nada). Sobrescrevível por env LINKEDIN_SCOPES caso algum
// escopo não esteja liberado no app (aí cai no preenchimento manual do id).
export const LINKEDIN_SCOPES =
  process.env.LINKEDIN_SCOPES ||
  'r_marketing_leadgen_automation r_organization_admin'

/** Precisa casar EXATAMENTE uma das "Authorized redirect URLs" cadastradas no app. */
export const LINKEDIN_REDIRECT_URI =
  'https://crm.salestecnologia.com.br/api/webhooks/lead-ads/linkedin/callback'

/** true quando as credenciais do app do LinkedIn estão no ambiente. */
export function linkedInConfigured(): boolean {
  return !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET)
}

/** Monta a URL de autorização com um `state` assinado (carrega o accountId). */
export function buildLinkedInAuthUrl(accountId: string): string {
  const clientId = process.env.LINKEDIN_CLIENT_ID
  if (!clientId) {
    throw new Error(
      'Conexão 1-clique do LinkedIn ainda não configurada (Lead Sync em análise). ' +
        'Use a conexão manual por enquanto.',
    )
  }
  const state = encrypt(JSON.stringify({ a: accountId, t: Date.now() }))
  const url = new URL(AUTH_BASE)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', LINKEDIN_REDIRECT_URI)
  url.searchParams.set('state', state)
  url.searchParams.set('scope', LINKEDIN_SCOPES)
  return url.toString()
}

/** Valida o `state` (assinado + fresco) e devolve o accountId. */
export function parseLinkedInState(
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

export interface LinkedInToken {
  accessToken: string
  expiresIn: number | null
  refreshToken: string | null
}

/** Troca o code por access_token (form-urlencoded, padrão OAuth 2.0). */
export async function exchangeLinkedInCode(
  code: string,
): Promise<LinkedInToken | null> {
  const clientId = process.env.LINKEDIN_CLIENT_ID
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: LINKEDIN_REDIRECT_URI,
      }),
    })
    const json = (await res.json()) as {
      access_token?: string
      expires_in?: number
      refresh_token?: string
    }
    if (!res.ok || !json.access_token) {
      console.error('[linkedin-oauth] token exchange failed', res.status, json)
      return null
    }
    return {
      accessToken: json.access_token,
      expiresIn: typeof json.expires_in === 'number' ? json.expires_in : null,
      refreshToken: json.refresh_token ?? null,
    }
  } catch (err) {
    console.error('[linkedin-oauth] exchange error', err)
    return null
  }
}

/**
 * Descobre as organizações que o usuário administra (best-effort). Precisa do
 * escopo rw_organization_admin; se não vier, retorna [] e o admin informa o
 * organization id na mão. Nunca lança.
 */
export async function fetchAdministeredOrgs(
  accessToken: string,
): Promise<string[]> {
  try {
    const url =
      `${API_BASE}/organizationAcls` +
      `?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202508',
        'X-Restli-Protocol-Version': '2.0.0',
      },
    })
    if (!res.ok) return []
    const json = (await res.json()) as { elements?: { organization?: string }[] }
    const ids = new Set<string>()
    for (const el of json.elements ?? []) {
      const m = (el.organization ?? '').match(/(\d+)(?!.*\d)/)
      if (m) ids.add(m[1])
    }
    return [...ids]
  } catch {
    return []
  }
}
