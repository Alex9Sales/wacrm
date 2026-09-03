// ============================================================
// Provisiona a org de TESTE (trial 7 dias) pra um usuário — usada pelo
// cadastro self-serve (/comecar → /api/trial/signup) e pela rota antiga
// /api/trial/provision (com sessão). IDEMPOTENTE e anti-abuso: se o usuário
// já é membro de alguma org, devolve essa e NÃO cria outra. A org nasce
// isolada e vazia — sem risco cross-tenant.
// ============================================================

import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'

import { db, member, organization, organizationBilling } from '@/db'
import { firstOrNull } from '@/db/helpers'

export const TRIAL_DAYS = 7

export function slugifyOrgName(name: string): string {
  const s = (name || 'conta')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tira acentos (combining marks)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || 'conta'
}

export function cleanOrgName(raw: unknown, fallback = 'Minha empresa'): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 80) : fallback
}

/** Cria org + membro owner + billing trial. Devolve { id, existing }. */
export async function provisionTrialOrg(
  userId: string,
  orgName: string,
): Promise<{ id: string; existing: boolean }> {
  const existing = firstOrNull(
    await db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, userId))
      .limit(1),
  )
  if (existing) return { id: existing.organizationId, existing: true }

  const [org] = await db
    .insert(organization)
    .values({ name: orgName, slug: `${slugifyOrgName(orgName)}-${randomUUID().slice(0, 6)}` })
    .returning({ id: organization.id })
  await db.insert(member).values({ userId, organizationId: org.id, role: 'owner' })
  const now = Date.now()
  await db.insert(organizationBilling).values({
    organizationId: org.id,
    status: 'trial',
    startedAt: new Date(now).toISOString(),
    dueAt: new Date(now + TRIAL_DAYS * 86_400_000).toISOString(),
    plan: null,
  })
  return { id: org.id, existing: false }
}
