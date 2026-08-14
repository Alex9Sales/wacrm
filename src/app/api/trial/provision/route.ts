import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'

import { db, organization, member, organizationBilling } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getSessionUserId } from '@/lib/auth/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ============================================================
// Fase 2 — Provisiona uma org de TESTE (trial 7 dias) para o usuário recém
// cadastrado (self-serve, a partir do /comecar). Cria org + membro (owner) +
// billing status='trial' com dueAt = +7d. IDEMPOTENTE e anti-abuso: se o
// usuário já tem qualquer org, NÃO cria outra. A org nasce isolada e vazia — sem
// risco cross-tenant. (O cadastro por convite continua fechado; este fluxo é só
// pra o trial do site de vendas.)
// ============================================================

const TRIAL_DAYS = 7

function slugify(name: string): string {
  const s = (name || 'conta')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tira acentos (combining marks)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || 'conta'
}

export async function POST(request: Request) {
  const userId = await getSessionUserId().catch(() => null)
  if (!userId) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 })
  }

  // Já é membro de alguma org → não cria outra (idempotente / anti-abuso).
  const existing = firstOrNull(
    await db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, userId))
      .limit(1),
  )
  if (existing) {
    return NextResponse.json({ ok: true, id: existing.organizationId, existing: true })
  }

  const body = await request.json().catch(() => null)
  const orgName =
    typeof body?.orgName === 'string' && body.orgName.trim()
      ? body.orgName.trim().slice(0, 80)
      : 'Minha empresa'

  try {
    const [org] = await db
      .insert(organization)
      .values({ name: orgName, slug: `${slugify(orgName)}-${randomUUID().slice(0, 6)}` })
      .returning({ id: organization.id })

    await db.insert(member).values({
      userId,
      organizationId: org.id,
      role: 'owner',
    })

    const now = Date.now()
    await db.insert(organizationBilling).values({
      organizationId: org.id,
      status: 'trial',
      startedAt: new Date(now).toISOString(),
      dueAt: new Date(now + TRIAL_DAYS * 86_400_000).toISOString(),
      plan: null,
    })

    return NextResponse.json({ ok: true, id: org.id })
  } catch (err) {
    console.error('[trial/provision] falha:', err)
    return NextResponse.json({ error: 'Não foi possível criar a conta.' }, { status: 500 })
  }
}
