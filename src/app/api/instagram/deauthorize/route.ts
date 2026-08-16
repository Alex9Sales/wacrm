// ============================================================
// Deauthorize callback do Instagram. Quando o usuário REMOVE o app da conta
// dele (Instagram → Configurações → Apps e sites → remover), a Meta faz um
// POST aqui com um `signed_request` assinado com o app secret. A gente valida
// a assinatura, extrai o id da conta (user_id) e marca o canal como
// `disconnected` — assim o CRM não fica achando que ainda tem acesso.
//
// É o par do "Data Deletion Request URL" (/exclusao-de-dados): desautorização
// = perdeu o acesso; exclusão = apagar os dados. A Meta pede as duas URLs no
// cadastro do app (App Dashboard → Instagram → Configurações básicas).
//
// Público no middleware: autentica pela assinatura (app secret), não sessão.
// ============================================================

import { NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { sql } from 'drizzle-orm'

import { db, channels } from '@/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const APP_SECRET = process.env.INSTAGRAM_APP_SECRET || ''

/** base64url → Buffer (aceita com/sem padding). */
function b64urlToBuffer(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4))
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

/**
 * Valida e decodifica o `signed_request` (`<sig>.<payload>`): a assinatura é
 * HMAC-SHA256 do payload cru (o texto DEPOIS do ponto) com o app secret.
 * Retorna o payload (com `user_id`) ou null se não bater.
 */
function parseSignedRequest(
  signedRequest: string,
  secret: string,
): { user_id?: string; algorithm?: string } | null {
  const dot = signedRequest.indexOf('.')
  if (dot < 0) return null
  const encodedSig = signedRequest.slice(0, dot)
  const encodedPayload = signedRequest.slice(dot + 1)

  const expected = createHmac('sha256', secret).update(encodedPayload).digest()
  const provided = b64urlToBuffer(encodedSig)
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null
  }

  try {
    return JSON.parse(b64urlToBuffer(encodedPayload).toString('utf8'))
  } catch {
    return null
  }
}

export async function POST(request: Request) {
  if (!APP_SECRET) {
    console.error('[instagram deauthorize] INSTAGRAM_APP_SECRET não configurado')
    // 200 mesmo assim: a Meta reenvia se der erro, e não queremos loop de retry
    // travando o app. Só logamos pra saber que o env sumiu.
    return NextResponse.json({ ok: true })
  }

  let signedRequest: string | null = null
  try {
    const form = await request.formData()
    const v = form.get('signed_request')
    if (typeof v === 'string') signedRequest = v
  } catch {
    /* corpo não-form: cai no null abaixo */
  }
  if (!signedRequest) {
    return NextResponse.json({ error: 'missing signed_request' }, { status: 400 })
  }

  const payload = parseSignedRequest(signedRequest, APP_SECRET)
  if (!payload?.user_id) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 })
  }

  // Marca o(s) canal(is) dessa conta IG como desconectado. Mantém o registro
  // (histórico/conversas) — só sinaliza que perdeu o acesso; o Alex reconecta
  // pelo botão "Conectar com Instagram" quando quiser.
  try {
    await db
      .update(channels)
      .set({ status: 'disconnected', updatedAt: new Date().toISOString() })
      .where(
        sql`${channels.provider} = 'instagram' AND ${channels.providerMeta}->>'ig_id' = ${payload.user_id}`,
      )
  } catch (error) {
    console.error('[instagram deauthorize] falha ao desconectar canal:', error)
  }

  return NextResponse.json({ ok: true })
}

// Alguns fluxos da Meta fazem um GET de verificação — responde 200 simples.
export async function GET() {
  return NextResponse.json({ ok: true })
}
