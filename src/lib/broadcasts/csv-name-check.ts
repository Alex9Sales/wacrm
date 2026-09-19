'use server'

// ============================================================
// Planilha sem nome: quantos contatos NOVOS vão nascer sem nome. SÓ LEITURA.
//
// 15/09 (GoLink): a planilha do Vitor só tinha telefones; 17 contatos novos
// ficaram sem nome e a busca por nome não achava ninguém. Telefone sem nome
// que já é contato com nome não é problema; o que nasce agora é. Mesma regra
// de "mesmo número" da importação (resolveOrCreateContactIdsByPhone): 8
// últimos dígitos no SQL + phonesMatch. Quem já existe sem nome é contado à
// parte (a importação preenche o nome dele se a linha trouxer um).
// ============================================================

import { and, eq, inArray, sql } from 'drizzle-orm'

import { db, contacts } from '@/db'
import { getCurrentAccount } from '@/lib/auth/account'
import { last8 } from '@/lib/contacts/dedupe'
import { normalizePhone, phonesMatch } from '@/lib/whatsapp/phone-utils'

export type CsvNamelessCheck =
  | { ok: true; newWithoutName: number; existingWithoutName: number }
  | { ok: false; error: string }

const MAX_PHONES = 20_000
const CHUNK = 1_000

/** Recebe os telefones SEM nome da planilha (summarizeCsvNames). */
export async function checkCsvNamelessContacts(phones: string[]): Promise<CsvNamelessCheck> {
  try {
    const ctx = await getCurrentAccount()
    const list = Array.from(
      new Set((Array.isArray(phones) ? phones : []).filter((p) => typeof p === 'string' && normalizePhone(p))),
    ).slice(0, MAX_PHONES)
    if (list.length === 0) return { ok: true, newWithoutName: 0, existingWithoutName: 0 }

    const suffixes = [...new Set(list.map(last8).filter(Boolean))]
    const existing: { phone: string; name: string | null }[] = []
    for (let i = 0; i < suffixes.length; i += CHUNK) {
      const rows = await db
        .select({ phone: contacts.phone, name: contacts.name })
        .from(contacts)
        .where(
          and(
            eq(contacts.accountId, ctx.accountId),
            inArray(sql`right(${contacts.phoneNormalized}, 8)`, suffixes.slice(i, i + CHUNK)),
          ),
        )
      existing.push(...rows)
    }
    const bySuffix = new Map<string, { phone: string; name: string | null }[]>()
    for (const c of existing) {
      if (!c.phone) continue
      const key = last8(c.phone)
      bySuffix.set(key, [...(bySuffix.get(key) ?? []), c])
    }

    let newWithoutName = 0
    let existingWithoutName = 0
    const seenNew = new Set<string>()
    for (const phone of list) {
      const key = last8(phone)
      const hit = (bySuffix.get(key) ?? []).find((c) => phonesMatch(c.phone, phone))
      if (hit) {
        if (!hit.name?.trim()) existingWithoutName++
        continue
      }
      if (seenNew.has(key)) continue
      seenNew.add(key)
      newWithoutName++
    }
    return { ok: true, newWithoutName, existingWithoutName }
  } catch (err) {
    console.error('[checkCsvNamelessContacts]', err)
    return { ok: false, error: 'Não deu pra conferir quais telefones já são contatos.' }
  }
}
