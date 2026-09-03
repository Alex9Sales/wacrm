import { NextResponse } from 'next/server'
import { APIError } from 'better-auth/api'

import { sql } from 'drizzle-orm'

import { db, user } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { auth } from '@/lib/auth'
import { cleanOrgName, provisionTrialOrg } from '@/lib/auth/trial-provision'
import { checkRateLimit, clientIp, rateLimitResponse } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ============================================================
// Cadastro self-serve (trial 7 dias) em UMA chamada, sem sessão:
//   1. cria o login (Better Auth) — com requireEmailVerification ligado o
//      signUp NÃO abre sessão, então a org é criada aqui no servidor;
//   2. provisiona a org de teste (owner + billing trial);
//   3. manda o e-mail de confirmação (link → entra logado no /dashboard).
// Público → rate limit por IP + honeypot (`website` preenchido = robô).
// ============================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(request: Request) {
  const rl = await checkRateLimit(`public:trial-signup:${clientIp(request)}`, { limit: 5, windowMs: 60_000 })
  if (!rl.success) return rateLimitResponse(rl)

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'Dados inválidos.' }, { status: 400 })
  if (typeof body.website === 'string' && body.website.trim()) {
    // honeypot: humano não vê esse campo
    return NextResponse.json({ ok: true })
  }
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!name || !EMAIL_RE.test(email) || password.length < 6) {
    return NextResponse.json({ error: 'Confira nome, e-mail e senha (mín. 6 caracteres).' }, { status: 400 })
  }
  const orgName = cleanOrgName(body.orgName, name)

  // Com requireEmailVerification ligado o Better Auth responde GENÉRICO pra
  // e-mail duplicado (anti-enumeração) — aqui a gente avisa claramente.
  const dup = firstOrNull(
    await db.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${email}`).limit(1),
  )
  if (dup) {
    return NextResponse.json(
      { error: 'Já existe uma conta com esse e-mail. Entre pelo login ou use "Esqueci minha senha".' },
      { status: 409 },
    )
  }

  let userId: string
  try {
    const res = await auth.api.signUpEmail({ body: { name, email, password } })
    userId = res.user.id
  } catch (err) {
    if (err instanceof APIError) {
      const code = (err.body as { code?: string } | undefined)?.code
      if (code === 'USER_ALREADY_EXISTS' || /exist/i.test(err.message)) {
        return NextResponse.json(
          { error: 'Já existe uma conta com esse e-mail. Entre pelo login ou use "Esqueci minha senha".' },
          { status: 409 },
        )
      }
      return NextResponse.json({ error: err.message || 'Não foi possível criar a conta.' }, { status: 400 })
    }
    console.error('[trial/signup] signUpEmail falhou:', err)
    return NextResponse.json({ error: 'Não foi possível criar a conta.' }, { status: 500 })
  }

  try {
    await provisionTrialOrg(userId, orgName)
  } catch (err) {
    console.error('[trial/signup] provisionamento falhou:', err)
    return NextResponse.json({ error: 'Não foi possível criar sua empresa.' }, { status: 500 })
  }

  try {
    await auth.api.sendVerificationEmail({ body: { email, callbackURL: '/dashboard' } })
  } catch (err) {
    // O login reenvia o link sozinho (sendOnSignIn) — não derruba o cadastro.
    console.error('[trial/signup] e-mail de confirmação falhou:', err)
  }

  return NextResponse.json({ ok: true })
}
