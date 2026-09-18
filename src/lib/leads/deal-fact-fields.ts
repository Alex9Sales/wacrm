// ============================================================
// Grava o que o lead respondeu no formulário nos CAMPOS do card (Cidade,
// Estado, Investimento, Campanha…) — Renato/Zelo 18/09: "no card não aparece o
// valor de investimento, nem cidade".
//
// Opt-in pela própria conta: só preenche campo personalizado de NEGÓCIO que
// existe com um desses nomes (ver factForFieldName). Conta sem os campos não
// ganha nada novo. Best-effort: nunca derruba a entrada do lead.
// Sem 'server-only' — o worker também pode chamar.
// ============================================================

import { and, eq, sql } from 'drizzle-orm'

import { customFields, db, dealCustomValues } from '@/db'
import { factForFieldName, type LeadFacts } from './lead-facts'

/** Preenche os campos de fato do negócio. Devolve quantos gravou. */
export async function fillDealFactFields(
  accountId: string,
  dealId: string,
  facts: LeadFacts,
): Promise<number> {
  try {
    const fields = await db
      .select({ id: customFields.id, name: customFields.fieldName })
      .from(customFields)
      .where(and(eq(customFields.accountId, accountId), eq(customFields.entity, 'deal')))
    const rows: { accountId: string; dealId: string; customFieldId: string; value: string }[] = []
    for (const f of fields) {
      const key = factForFieldName(f.name)
      const value = key ? facts[key] : null
      if (value && value.trim()) {
        rows.push({ accountId, dealId, customFieldId: f.id, value: value.trim().slice(0, 500) })
      }
    }
    if (!rows.length) return 0
    await db
      .insert(dealCustomValues)
      .values(rows)
      .onConflictDoUpdate({
        target: [dealCustomValues.dealId, dealCustomValues.customFieldId],
        set: { value: sql`excluded.value`, updatedAt: sql`now()` },
      })
    return rows.length
  } catch (err) {
    console.error('[deal-fact-fields] falhou:', err instanceof Error ? err.message : err)
    return 0
  }
}
