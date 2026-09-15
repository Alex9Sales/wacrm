// ============================================================
// POST /api/channels/:id/gmail-password — troca a senha de app de um canal
// Gmail sem recriar o canal (mantém conversas e o ponto de leitura).
//
// 15/09 (GoLink): o Google revogou a senha de app e a única saída era apagar o
// canal. Aqui: admin cola a senha nova → testamos no Google (SMTP + IMAP) →
// só então gravamos. Regras em lib/channels/gmail-credentials.ts.
//
// Body: { app_password }. O endereço NÃO vem do corpo (400 se vier): o ponto de
// leitura salvo é daquela caixa.
//
// Limite: 5 tentativas / 10 min por canal — cada tentativa é um login no
// Google, e logins recusados em série podem bloquear a conta.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { replaceGmailAppPassword, GMAIL_MSG } from '@/lib/channels/gmail-credentials'
import { checkRateLimit } from '@/lib/rate-limit'

interface RouteParams {
  params: Promise<{ id: string }>
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params

    const rl = await checkRateLimit(`gmail-pw:${ctx.accountId}:${id}`, {
      limit: 5,
      windowMs: 10 * 60_000,
    })
    if (!rl.success) {
      const retryAfterSec = Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000))
      return NextResponse.json(
        {
          error:
            'Muitas tentativas. Espere alguns minutos: o Google pode bloquear a conta por excesso de logins.',
        },
        { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Pedido inválido.' }, { status: 400 })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Pedido inválido.' }, { status: 400 })
    }
    const { app_password, ...rest } = body as { app_password?: unknown; [k: string]: unknown }
    if ('address' in rest) {
      return NextResponse.json(
        {
          error:
            'O endereço de um canal Gmail não pode ser trocado: crie um canal novo para outro Gmail.',
        },
        { status: 400 },
      )
    }
    if (typeof app_password !== 'string' || !app_password.trim()) {
      return NextResponse.json({ error: GMAIL_MSG.badFormat }, { status: 400 })
    }

    const result = await replaceGmailAppPassword(ctx.accountId, id, app_password)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.httpStatus })
    }
    return NextResponse.json({
      ok: true,
      pollResumesNow: result.pollResumesNow,
      mailboxMatches: result.mailboxMatches,
      backlogEstimate: result.backlogEstimate,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
