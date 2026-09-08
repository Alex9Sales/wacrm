// ============================================================
// Busca de contato por nome OU telefone, no servidor (sem sessão).
// Usada pelo comando do dono ("cria uma cobrança pro Fulano"). Devolve poucos
// e deixa a ambiguidade visível — escolher entre dois Joãos é decisão de gente.
// Nome em camadas (search-tiers.ts): "Danyela Souza" acha o contato "Danyela".
// Sem 'server-only' — o worker alcança.
// ============================================================

import { and, eq, sql } from 'drizzle-orm'

import { db, contacts } from '@/db'

import { nameSearchTiers } from './search-tiers'

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
  const base = and(eq(contacts.accountId, accountId), eq(contacts.isGroup, false))
  const select = () => db.select({ id: contacts.id, name: contacts.name, phone: contacts.phone, email: contacts.email }).from(contacts)

  if (byPhone) {
    return select()
      .where(and(base, sql`${contacts.phoneNormalized} LIKE ${'%' + digits.slice(-8)}`))
      .orderBy(contacts.name)
      .limit(limit)
  }
  for (const words of nameSearchTiers(term)) {
    const rows = await select()
      .where(and(base, ...words.map((w) => sql`${contacts.name} ILIKE ${'%' + w + '%'}`)))
      .orderBy(contacts.name)
      .limit(limit)
    if (rows.length) return rows
  }
  return []
}
