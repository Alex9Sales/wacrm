// ============================================================
// 🧾 Cobrança que VENCEU mas o Asaas ainda mostra como PENDING.
//
// João/GoLink, 21/09: 13 boletos do dia 20 continuavam PENDING no Asaas no
// dia seguinte. Eram invisíveis para o CRM inteiro — o sync só lê os
// `overdueStatuses` (OVERDUE), o lembrete só olha de hoje para frente, e nada
// disso ia para o banco. A régua nunca cobraria; a tela nunca mostraria.
//
// Regra: além dos status configurados, o sync lê `PENDING` com vencimento até
// ONTEM (no fuso da conta) e espelha essas linhas como o que elas são —
// vencidas. Tudo que já filtra por `open=true` + data passa a vê-las certo.
//
// As funções aqui são puras (sem banco, sem rede) para terem teste. O SQL do
// sync espelha `mayCloseUnseen`.
// ============================================================

import { addDaysKey } from '@/lib/collections/upcoming-unmatched'

/** Vencimento máximo que conta como "já venceu": ontem, no dia da conta. */
export function overduePendingCutoff(todayKey: string): string {
  return addDaysKey(todayKey, -1)
}

/**
 * Junta as listagens (status configurados + PENDING vencida) sem repetir a
 * mesma cobrança: a primeira lista vence, porque veio do status "de verdade".
 */
export function mergePayments<T extends { id: string }>(primary: readonly T[], extra: readonly T[]): T[] {
  const seen = new Set(primary.map((p) => p.id))
  const out = [...primary]
  for (const p of extra) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
  }
  return out
}

/**
 * Uma linha aberta que NÃO apareceu na listagem desta rodada pode ser fechada?
 * Só se ela pertence a uma listagem que rodou: status configurado (sempre), ou
 * PENDING com vencimento até o corte (só quando a listagem de PENDING vencida
 * deu certo — `pendingCutoff` null = não rodou, não feche).
 *
 * Cobrança criada pelo CRM nasce PENDING com vencimento FUTURO: continua fora
 * do fechamento, como sempre foi (05/09).
 */
export function mayCloseUnseen(
  row: { status: string; dueDate: string | null },
  statuses: readonly string[],
  pendingCutoff: string | null,
): boolean {
  if (statuses.includes(row.status)) return true
  if (!pendingCutoff || row.status !== 'PENDING' || !row.dueDate) return false
  return row.dueDate.slice(0, 10) <= pendingCutoff
}
