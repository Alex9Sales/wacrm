// ============================================================
// Grava o que o lead respondeu no formulário nos CAMPOS do card (Cidade,
// Estado, Investimento, Campanha…) — Renato/Zelo 18/09: "no card não aparece o
// valor de investimento, nem cidade".
//
// Opt-in pela própria conta: só preenche campo personalizado de NEGÓCIO que
// existe com um desses nomes (ver factForFieldName). Conta sem os campos não
// ganha nada novo. Best-effort: nunca derruba a entrada do lead.
// Sem 'server-only' — o worker também pode chamar.
//
// Duas regras de escrita (Zelo 01/10 — o marketing quer saber DE ONDE o lead
// veio e via "Campanha: unknown"):
//   • Cidade/Estado/Investimento/…: o mais novo vence (o lead pode corrigir).
//   • Campanha: o PRIMEIRO toque bom vence. Conversão seguinte do mesmo lead
//     (inclusive as que o próprio RD gera quando o espelho mexe no negócio)
//     não troca a campanha que trouxe o lead. Campanha genérica ("unknown")
//     nunca é gravada — e uma "unknown" que já esteja lá (gravada antes do
//     conserto) é trocada pela primeira boa que chegar.
// ============================================================

import { and, eq, inArray, sql } from 'drizzle-orm'

import { customFields, db, dealCustomValues } from '@/db'
import { factForFieldName, type LeadFacts, usefulOrigin } from './lead-facts'

type FactRow = { accountId: string; dealId: string; customFieldId: string; value: string }

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
    const newest: FactRow[] = []
    const firstTouch: FactRow[] = []
    for (const f of fields) {
      const key = factForFieldName(f.name)
      if (!key) continue
      // Campanha passa pela mesma limpeza da nota: "Facebook Ads / unknown"
      // vira "Facebook Ads"; só "unknown" (ou rótulo do RD CRM) vira nada e
      // não é gravada.
      const value = key === 'campanha' ? usefulOrigin(facts[key]) : (facts[key] ?? '').trim()
      if (!value) continue
      const row = { accountId, dealId, customFieldId: f.id, value: value.slice(0, 500) }
      if (key === 'campanha') firstTouch.push(row)
      else newest.push(row)
    }

    let written = 0
    if (newest.length) {
      const saved = await db
        .insert(dealCustomValues)
        .values(newest)
        .onConflictDoUpdate({
          target: [dealCustomValues.dealId, dealCustomValues.customFieldId],
          set: { value: sql`excluded.value`, updatedAt: sql`now()` },
        })
        .returning({ id: dealCustomValues.id })
      written += saved.length
    }
    if (firstTouch.length) written += await fillFirstTouch(accountId, dealId, firstTouch)
    return written
  } catch (err) {
    console.error('[deal-fact-fields] falhou:', err instanceof Error ? err.message : err)
    return 0
  }
}

/**
 * Campanha: só grava onde ainda não há uma BOA. Lê o que está lá (régua JS do
 * usefulOrigin, que o SQL não reproduz) e grava com compare-and-swap: o
 * UPDATE do conflito só acontece se o valor continua o que foi lido (ou vazio).
 * Duas conversões do mesmo lead ao mesmo tempo não trocam a campanha que a
 * outra acabou de gravar.
 */
async function fillFirstTouch(accountId: string, dealId: string, rows: FactRow[]): Promise<number> {
  const current = await db
    .select({ customFieldId: dealCustomValues.customFieldId, value: dealCustomValues.value })
    .from(dealCustomValues)
    .where(
      and(
        eq(dealCustomValues.accountId, accountId),
        eq(dealCustomValues.dealId, dealId),
        inArray(
          dealCustomValues.customFieldId,
          rows.map((r) => r.customFieldId),
        ),
      ),
    )
  const byField = new Map(current.map((c) => [c.customFieldId, c.value]))

  let written = 0
  for (const row of rows) {
    const had = byField.get(row.customFieldId)
    // Primeiro toque bom já está lá. "unknown" ou "Tarefa criada no RD
    // Station CRM" gravados antes de 01/10 não contam como bons: são trocados.
    if (usefulOrigin(had)) continue
    const blankNow = sql`(${dealCustomValues.value} IS NULL OR btrim(${dealCustomValues.value}) = '')`
    const saved = await db
      .insert(dealCustomValues)
      .values(row)
      .onConflictDoUpdate({
        target: [dealCustomValues.dealId, dealCustomValues.customFieldId],
        set: { value: sql`excluded.value`, updatedAt: sql`now()` },
        setWhere: had ? sql`(${blankNow} OR ${dealCustomValues.value} = ${had})` : blankNow,
      })
      .returning({ id: dealCustomValues.id })
    written += saved.length
  }
  return written
}
