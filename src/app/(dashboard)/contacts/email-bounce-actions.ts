'use server'

// ============================================================
// 📭 "E-mail voltou" na lateral do contato — ler e liberar.
//
// 15/09 (GoLink/Vale Ouro): a devolução da cobrança agora suprime o endereço
// (email_bounces) e a régua para de mandar e-mail pra ele. Sem mostrar isso, a
// equipe não saberia por que o cliente parou de receber e-mail, nem teria como
// desfazer quando o cliente corrigir a caixa. Os endereços vêm do contato e
// das parcelas do Asaas dele (a régua usa os dois).
// ============================================================

import { and, eq, sql } from 'drizzle-orm'

import { db, asaasCharges, contacts } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { bounceReason } from '@/lib/channels/email-bounce'
import { clearEmailBounce, emailBounceFor } from '@/lib/collections/email-suppression'

export interface ContactEmailBounce {
  address: string
  /** Motivo em português simples ("o domínio não recebe e-mail"). */
  reason: string
  statusCode: string | null
  lastBouncedAt: string
  bounceCount: number
}

export async function getContactEmailBounces(contactId: string): Promise<ContactEmailBounce[]> {
  const ctx = await getCurrentAccount()
  const contact = firstOrNull(
    await db
      .select({ email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!contact) return []
  const charges = await db
    .selectDistinct({ email: asaasCharges.email })
    .from(asaasCharges)
    .where(
      and(
        eq(asaasCharges.accountId, ctx.accountId),
        eq(asaasCharges.contactId, contactId),
        sql`nullif(trim(${asaasCharges.email}), '') IS NOT NULL`,
      ),
    )
    .limit(20)
  const rows = await emailBounceFor(ctx.accountId, [contact.email, ...charges.map((c) => c.email)], contactId)
  return rows.map((r) => ({
    address: r.address,
    reason: bounceReason(r.statusCode, r.diagnostic),
    statusCode: r.statusCode,
    lastBouncedAt: r.lastBouncedAt,
    bounceCount: r.bounceCount,
  }))
}

export async function releaseContactEmailBounce(
  address: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getCurrentAccount()
  if (!hasMinRole(ctx.role, 'supervisor')) {
    return { ok: false, error: 'Só supervisor ou admin pode liberar um e-mail que voltou.' }
  }
  try {
    const cleared = await clearEmailBounce(ctx.accountId, address, ctx.userId)
    if (!cleared) return { ok: false, error: 'Este e-mail já estava liberado.' }
    return { ok: true }
  } catch (err) {
    console.error('[contacts] liberar e-mail devolvido falhou conta=%s:', ctx.accountId, err)
    return { ok: false, error: 'Não foi possível liberar o e-mail agora. Tente de novo.' }
  }
}
