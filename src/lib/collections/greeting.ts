// ============================================================
// Saudação da cobrança para UM contato, com os dados do banco: o nome do CRM
// (e de onde ele veio) + o cliente do Asaas (nome e CPF/CNPJ) da cobrança mais
// recente. É a mesma regra da régua (`collectionGreetingName`) — quem manda
// link de cobrança fora da régua (tela de Cobranças, comando do dono) usava
// `greetingName` direto e ignorava a agenda "Pessoa - Empresa" (01/10, João).
// Sem 'server-only' — o worker também usa.
// ============================================================

import { and, desc, eq } from 'drizzle-orm'

import { asaasCharges, contacts, db } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { collectionGreetingName } from './rules'

/** Telefone cru no lugar do nome ("+55 12 99123-4567") não é jeito de chamar ninguém. */
function looksLikeBarePhone(name: string | null | undefined): boolean {
  const s = (name ?? '').trim()
  return !!s && /^[+\d\s().-]+$/.test(s)
}

export async function greetingNameForContact(accountId: string, contactId: string): Promise<string | null> {
  const contact = firstOrNull(
    await db
      .select({ name: contacts.name, nameSource: contacts.nameSource })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
      .limit(1),
  )
  const charge = firstOrNull(
    await db
      .select({ name: asaasCharges.customerName, doc: asaasCharges.cpfCnpj })
      .from(asaasCharges)
      .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.contactId, contactId)))
      .orderBy(desc(asaasCharges.updatedAt))
      .limit(1),
  )
  return collectionGreetingName(
    charge?.name ?? null,
    looksLikeBarePhone(contact?.name) ? null : (contact?.name ?? null),
    contact?.nameSource ?? null,
    charge?.doc ?? null,
  )
}
