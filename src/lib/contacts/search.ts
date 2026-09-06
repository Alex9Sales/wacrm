// ============================================================
// Busca de contato por nome OU telefone, no servidor (sem sessão).
// Usada pelo comando do dono ("cria uma cobrança pro Fulano"). Devolve poucos
// e deixa a ambiguidade visível — escolher entre dois Joãos é decisão de gente.
// Sem 'server-only' — o worker alcança.
// ============================================================

import { and, eq, sql } from 'drizzle-orm'

import { db, contacts } from '@/db'

export interface FoundContact {
  id: string
  name: string | null
  phone: string
  email: string | null
}

export async function findContactsByQuery(accountId: string, q: string, limit = 5): Promise<FoundContact[]> {
  const term = q.trim()
  if (!term) return []
  const digits = term.replace(/\D/g, '')
  const byPhone = digits.length >= 8
  const rows = await db
    .select({ id: contacts.id, name: contacts.name, phone: contacts.phone, email: contacts.email })
    .from(contacts)
    .where(
      and(
        eq(contacts.accountId, accountId),
        eq(contacts.isGroup, false),
        byPhone
          ? sql`${contacts.phoneNormalized} LIKE ${'%' + digits.slice(-8)}`
          : sql`${contacts.name} ILIKE ${'%' + term.replace(/[%_]/g, '') + '%'}`,
      ),
    )
    .orderBy(contacts.name)
    .limit(limit)
  return rows
}
