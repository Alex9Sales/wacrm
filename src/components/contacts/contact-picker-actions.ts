'use server'

// ============================================================
// Server actions do ContactPicker (seletor universal de contato):
//   • busca por nome, telefone, e-mail e CÓDIGO do cliente;
//   • criar contato rapidinho sem sair do formulário (venda feita em outro
//     lugar → cria o contato aqui mesmo e segue criando o negócio).
// Tudo escopado na conta.
// ============================================================

import { and, desc, eq, or, sql } from 'drizzle-orm'

import { db, contacts } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import { findOrCreateContact } from '@/lib/api/v1/contacts'

export interface PickerContact {
  id: string
  name: string | null
  phone: string | null
  email: string | null
  code: string | null
}

const pickerCols = {
  id: contacts.id,
  name: contacts.name,
  phone: contacts.phone,
  email: contacts.email,
  code: sql<string | null>`NULLIF((${contacts.customerCodes})[1], '')`,
}

/**
 * Busca contatos pro seletor. Sem termo → os 20 mais recentes. Com termo →
 * casa nome/e-mail (ILIKE), telefone (por dígitos) e código do cliente.
 * Retorna NULL em erro (o cliente mostra "recarregue" em vez de lista vazia).
 */
export async function searchPickerContacts(
  q: string,
): Promise<PickerContact[] | null> {
  try {
    const ctx = await getCurrentAccount()
    const term = (q ?? '').trim().slice(0, 80)
    if (!term) {
      return await db
        .select(pickerCols)
        .from(contacts)
        .where(eq(contacts.accountId, ctx.accountId))
        .orderBy(desc(contacts.updatedAt))
        .limit(20)
    }
    const like = `%${term}%`
    const digits = term.replace(/\D/g, '')
    const conds = [
      sql`${contacts.name} ILIKE ${like}`,
      sql`${contacts.email} ILIKE ${like}`,
      // código do cliente: casa qualquer um dos códigos, parcial e sem caixa.
      sql`EXISTS (SELECT 1 FROM unnest(${contacts.customerCodes}) cc WHERE cc ILIKE ${like})`,
    ]
    if (digits.length >= 4) {
      conds.push(sql`${contacts.phone} LIKE ${'%' + digits + '%'}`)
    }
    return await db
      .select(pickerCols)
      .from(contacts)
      .where(and(eq(contacts.accountId, ctx.accountId), or(...conds)))
      .orderBy(desc(contacts.updatedAt))
      .limit(20)
  } catch (err) {
    console.error('[searchPickerContacts]', err)
    return null
  }
}

/** Um contato pelo id (pro picker mostrar o rótulo de um valor já salvo). */
export async function getPickerContact(
  id: string,
): Promise<PickerContact | null> {
  try {
    const ctx = await getCurrentAccount()
    return firstOrNull(
      await db
        .select(pickerCols)
        .from(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)))
        .limit(1),
    )
  } catch {
    return null
  }
}

/**
 * Cria um contato rapidinho (nome + WhatsApp com DDD, e-mail opcional) e
 * devolve pronto pra seleção. Telefone repetido → devolve o contato EXISTENTE
 * (dedupe do findOrCreateContact, com advisory lock).
 */
export async function createPickerContact(input: {
  name: string
  phone: string
  email?: string | null
}): Promise<{ contact: PickerContact | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const name = (input.name ?? '').trim()
    const phone = (input.phone ?? '').trim()
    if (!name) return { contact: null, error: 'Informe o nome.' }
    const digits = phone.replace(/\D/g, '')
    const national = digits.startsWith('55') ? digits.slice(2) : digits
    if (national.length < 10 || national.length > 11) {
      return {
        contact: null,
        error: 'WhatsApp com DDD, por favor — ex.: (67) 99999-9999',
      }
    }
    const c = await findOrCreateContact(ctx.accountId, ctx.userId, {
      phone: digits.startsWith('55') ? digits : `55${digits}`,
      name,
      email: (input.email ?? '').trim() || undefined,
    })
    const row = firstOrNull(
      await db
        .select(pickerCols)
        .from(contacts)
        .where(eq(contacts.id, c.id))
        .limit(1),
    )
    return { contact: row ?? null, error: null }
  } catch (err) {
    console.error('[createPickerContact]', err)
    return { contact: null, error: 'Falha ao criar o contato. Tente de novo.' }
  }
}
