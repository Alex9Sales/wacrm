// ============================================================
// Início do OAuth "Conectar Instagram" (Instagram API com login do Instagram).
// GET autenticado (admin) → assina o state (conta+usuário) e redireciona pro
// authorize do Instagram. O callback (/api/instagram/oauth/callback) troca o
// code por token e cria o canal.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const IG_APP_ID = process.env.INSTAGRAM_APP_ID || '1040945168862432'
const REDIRECT =
  process.env.INSTAGRAM_OAUTH_REDIRECT ||
  'https://crm.salestecnologia.com.br/api/instagram/oauth/callback'
const APP_URL = process.env.APP_URL || 'https://crm.salestecnologia.com.br'
// Escopos do "Instagram API com login do Instagram" p/ mensagens.
const SCOPES = 'instagram_business_basic,instagram_business_manage_messages'

export async function GET() {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch {
    return NextResponse.redirect(`${APP_URL}/settings?ig=auth`)
  }

  const state = encrypt(
    JSON.stringify({ a: ctx.accountId, u: ctx.userId, t: Date.now() }),
  )
  const url =
    'https://www.instagram.com/oauth/authorize?enable_fb_login=0&force_authentication=1' +
    `&client_id=${IG_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    '&response_type=code' +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&state=${encodeURIComponent(state)}`
  return NextResponse.redirect(url)
}
