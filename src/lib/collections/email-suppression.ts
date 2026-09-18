// ============================================================
// 📭 E-mails que voltaram — consulta e liberação da supressão.
//
// 15/09 (GoLink/Vale Modelo): a cobrança por e-mail para um domínio com Null MX
// voltou e a régua ia mandar de novo em 17/09. email-bounce-apply.ts grava a
// devolução PERMANENTE em email_bounces (por endereço, não por contato — o
// mesmo e-mail aparece em mais de um contato e em asaas_charges.email).
// Aqui a régua pergunta "este endereço voltou?" e a lateral do contato mostra
// o selo e libera de novo. Liberar não apaga: marca cleared_at (fica o
// histórico, e uma nova devolução suprime outra vez).
//
// Sem 'server-only' — a régua roda no worker.
// ============================================================

import { and, eq, inArray, isNull, or } from 'drizzle-orm'

import { db, emailBounces } from '@/db'
import { emailAddressesIn } from '@/lib/channels/email-bounce'

/** Endereços candidatos → minúsculos, válidos, sem repetição. */
function normalizeCandidates(candidates: readonly unknown[]): string[] {
  return Array.from(new Set(candidates.flatMap((c) => emailAddressesIn(c))))
}

/** Dos candidatos, quais estão suprimidos (voltaram e ninguém liberou). */
export async function suppressedEmails(
  accountId: string,
  candidates: readonly (string | null | undefined)[],
): Promise<Set<string>> {
  const list = normalizeCandidates(candidates)
  if (!list.length) return new Set()
  const rows = await db
    .select({ address: emailBounces.address })
    .from(emailBounces)
    .where(and(eq(emailBounces.accountId, accountId), inArray(emailBounces.address, list), isNull(emailBounces.clearedAt)))
  return new Set(rows.map((r) => r.address))
}

export interface EmailBounceInfo {
  address: string
  statusCode: string | null
  diagnostic: string | null
  bounceCount: number
  lastBouncedAt: string
}

/** Devoluções ativas destes endereços (para o selo "E-mail voltou" na lateral). */
export async function emailBounceFor(
  accountId: string,
  addresses: readonly (string | null | undefined)[],
  /** Também as devoluções gravadas pra este contato (e-mail que veio da API do Asaas). */
  contactId?: string,
): Promise<EmailBounceInfo[]> {
  const list = normalizeCandidates(addresses)
  if (!list.length && !contactId) return []
  const match =
    list.length && contactId
      ? or(inArray(emailBounces.address, list), eq(emailBounces.contactId, contactId))
      : list.length
        ? inArray(emailBounces.address, list)
        : eq(emailBounces.contactId, contactId!)
  return db
    .select({
      address: emailBounces.address,
      statusCode: emailBounces.statusCode,
      diagnostic: emailBounces.diagnostic,
      bounceCount: emailBounces.bounceCount,
      lastBouncedAt: emailBounces.lastBouncedAt,
    })
    .from(emailBounces)
    .where(and(eq(emailBounces.accountId, accountId), match, isNull(emailBounces.clearedAt)))
}

/** Libera o endereço para a régua voltar a mandar. true = havia supressão ativa. */
export async function clearEmailBounce(accountId: string, address: string, userId: string): Promise<boolean> {
  const [addr] = emailAddressesIn(address)
  if (!addr) return false
  const rows = await db
    .update(emailBounces)
    .set({ clearedAt: new Date().toISOString(), clearedBy: userId })
    .where(and(eq(emailBounces.accountId, accountId), eq(emailBounces.address, addr), isNull(emailBounces.clearedAt)))
    .returning({ id: emailBounces.id })
  return rows.length > 0
}
