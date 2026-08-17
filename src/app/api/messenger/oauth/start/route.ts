// ============================================================
// Início do OAuth "Conectar Messenger" (Facebook Login). GET autenticado
// (admin) → assina o state (conta+usuário) e redireciona pro dialog de OAuth
// do Facebook. O callback (/api/messenger/oauth/callback) troca o code por
// token, lista as Páginas do usuário, cria os canais Messenger e já inscreve
// cada Página no webhook (subscribed_apps) — sem colar token na mão.
//
// Precisa de env: META_APP_SECRET. O app id (público) tem default.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FB_APP_ID =
  process.env.NEXT_PUBLIC_META_APP_ID ||
  process.env.META_APP_ID ||
  '1920154046039310'
const REDIRECT =
  process.env.MESSENGER_OAUTH_REDIRECT ||
  'https://crm.salestecnologia.com.br/api/messenger/oauth/callback'
const APP_URL = process.env.APP_URL || 'https://crm.salestecnologia.com.br'
// Escopos do Messenger: listar Páginas + mandar/receber DM + inscrever o
// webhook da Página (subscribed_apps). No app em dev/standard, o admin/tester
// concede mesmo sem App Review; clientes de verdade exigem App Review.
const SCOPES = 'pages_show_list,pages_messaging,pages_manage_metadata'

export async function GET() {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch {
    return NextResponse.redirect(`${APP_URL}/settings?tab=channels&messenger=auth`)
  }

  const state = encrypt(
    JSON.stringify({ a: ctx.accountId, u: ctx.userId, t: Date.now() }),
  )
  const url =
    'https://www.facebook.com/v21.0/dialog/oauth?response_type=code' +
    `&client_id=${FB_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&state=${encodeURIComponent(state)}`
  return NextResponse.redirect(url)
}
