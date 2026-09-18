// ============================================================
// "O que o lead JÁ nos contou" — bloco do prompt montado a partir do card
// ligado à conversa: campos personalizados do negócio + origem + o que o
// formulário trouxe (observações gravadas na entrada do lead).
//
// Zelo 18/09: o formulário do RD dizia "São Paulo, acima de R$ 50 mil, quer
// conhecer a franquia" e a Zélia perguntou a cidade e, três vezes, o capital —
// esses dados nunca chegavam no prompt. Agora chegam, DESARMADOS (quem
// escreveu foi o lead: é informação, nunca instrução).
// Sem 'server-only' — roda no worker.
// ============================================================

import { and, desc, eq } from 'drizzle-orm'

import { customFields, db, dealCustomValues, deals } from '@/db'
import { firstOrNull } from '@/db/helpers'
import {
  factForFieldName,
  leadLinesForPrompt,
  parseNoteLines,
  prettyFormValue,
  type FactKey,
} from '@/lib/leads/lead-facts'
import { neutralizeUntrusted } from './untrusted'

/** Teto de linhas e de caracteres: formulário grande não pode inchar o prompt. */
const MAX_LINES = 25
const MAX_CHARS = 2500

export async function loadLeadFormContext(
  accountId: string,
  conversationId: string,
): Promise<string | null> {
  try {
    // O card ABERTO ligado a esta conversa (o mais novo) — o mesmo que a IA
    // move/perde/ganha.
    const deal = firstOrNull(
      await db
        .select({ id: deals.id, notes: deals.notes, origin: deals.origin, source: deals.source })
        .from(deals)
        .where(
          and(
            eq(deals.accountId, accountId),
            eq(deals.conversationId, conversationId),
            eq(deals.status, 'open'),
          ),
        )
        .orderBy(desc(deals.createdAt))
        .limit(1),
    )
    if (!deal) return null

    const custom = await db
      .select({ name: customFields.fieldName, value: dealCustomValues.value })
      .from(dealCustomValues)
      .innerJoin(customFields, eq(customFields.id, dealCustomValues.customFieldId))
      .where(and(eq(dealCustomValues.dealId, deal.id), eq(dealCustomValues.accountId, accountId)))

    const lines: string[] = []
    const covered = new Set<FactKey>()
    for (const c of custom) {
      const v = prettyFormValue(c.value ?? '')
      if (!v) continue
      lines.push(`${c.name}: ${v}`)
      const f = factForFieldName(c.name)
      if (f) covered.add(f)
    }
    const origin = [deal.origin, deal.source].map((s) => (s ?? '').trim()).filter(Boolean)
    if (origin.length) lines.push(`Origem do lead: ${origin.join(' — ')}`)
    lines.push(...leadLinesForPrompt(parseNoteLines(deal.notes), covered))

    const text = lines.slice(0, MAX_LINES).join('\n').trim()
    if (!text) return null
    return neutralizeUntrusted(text, { maxChars: MAX_CHARS })
  } catch (err) {
    console.error('[lead-form-context] falhou:', err instanceof Error ? err.message : err)
    return null
  }
}
