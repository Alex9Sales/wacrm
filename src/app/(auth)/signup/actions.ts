'use server'

// ============================================================
// Cadastro por convite: o link do convite chegou no e-mail da pessoa, então
// ele já PROVA o e-mail. Se o cadastro foi feito com o MESMO e-mail do convite
// (pendente e dentro do prazo), marca a conta como verificada — sem exigir
// um segundo e-mail. Qualquer outro caso cai no fluxo normal de confirmação.
// ============================================================

import { eq, sql } from 'drizzle-orm'

import { db, invitation, user } from '@/db'
import { firstOrNull } from '@/db/helpers'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function confirmInvitedSignup(
  inviteToken: string,
  email: string,
): Promise<{ ok: boolean }> {
  const token = String(inviteToken || '').trim()
  const mail = String(email || '').trim().toLowerCase()
  if (!UUID_RE.test(token) || !mail) return { ok: false }

  const inv = firstOrNull(
    await db
      .select({ email: invitation.email, status: invitation.status, expiresAt: invitation.expiresAt })
      .from(invitation)
      .where(eq(invitation.id, token))
      .limit(1),
  )
  if (!inv) return { ok: false }
  if (inv.status !== 'pending') return { ok: false }
  if (inv.email.trim().toLowerCase() !== mail) return { ok: false }
  if (new Date(inv.expiresAt).getTime() < Date.now()) return { ok: false }

  await db
    .update(user)
    .set({ emailVerified: true })
    .where(sql`lower(${user.email}) = ${mail}`)
  return { ok: true }
}
