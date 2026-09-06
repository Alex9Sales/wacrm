// ============================================================
// 📊 "É a mesma venda?" — a regra pura por trás de nunca duplicar o histórico.
//
// A MESMA venda chega por até três caminhos: planilha ('import', só a data —
// grava às 12:00 UTC), ERP ('erp', hora exata) e Ganho no funil ('deal', a
// hora em que alguém clicou). 06/09: Família do Gás com 4.032 pares
// importação×ERP e 178 negócio×ERP. A dedupe das métricas comparava a DATA em
// UTC — venda das 21h local cai no dia seguinte e contava duas vezes (Miriam).
//
// Regra: mesmo contato + mesmo valor + até 36h de distância = mesma venda.
// 36h cobre "só a data" (meio-dia UTC) contra qualquer hora do mesmo dia local
// e o Ganho marcado no dia seguinte. Quem fica é a fonte mais precisa:
// erp > deal > import. Só ESCOLHE — quem grava é merge.ts.
// ============================================================

export type SaleSource = 'erp' | 'deal' | 'import' | string

export const SAME_SALE_WINDOW_HOURS = 36

/** Menor = mais confiável = fica. */
export const SOURCE_PRIORITY: Record<string, number> = { erp: 0, deal: 1, import: 2 }

export function sourceRank(source: SaleSource): number {
  return SOURCE_PRIORITY[source] ?? 3
}

export interface SaleLike {
  id: string
  source: SaleSource
  amount: number
  occurredAt: string
}

/** Ganho no funil pode vir com o valor do negócio (sem o desconto do caixa): tolera até 10% ou R$ 5. */
function amountsMatch(a: SaleLike, b: SaleLike): boolean {
  const diff = Math.abs(a.amount - b.amount)
  if (diff < 0.005) return true
  if (a.source === 'deal' || b.source === 'deal') {
    return diff <= Math.max(5, 0.1 * Math.max(a.amount, b.amount))
  }
  return false
}

export function isSameSale(a: SaleLike, b: SaleLike, windowHours = SAME_SALE_WINDOW_HOURS): boolean {
  if (a.id === b.id || a.source === b.source) return false
  if (!amountsMatch(a, b)) return false
  const dt = Math.abs(new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime())
  return Number.isFinite(dt) && dt <= windowHours * 3_600_000
}

export interface MergeDecision {
  keep: SaleLike
  merge: SaleLike
}

/**
 * Dado um conjunto de vendas de UM contato, quais linhas somem dentro de quais.
 * Cada linha é absorvida no máximo uma vez, pela candidata mais próxima no
 * tempo entre as de fonte mais confiável. Duas vendas de verdade no mesmo dia
 * (dois botijões em dois pedidos) ficam: cada linha "ganha" absorve só UMA.
 */
export function planMerges(sales: SaleLike[]): MergeDecision[] {
  const ordered = [...sales].sort(
    (a, b) => sourceRank(a.source) - sourceRank(b.source) || new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
  )
  const absorbed = new Set<string>()
  const used = new Set<string>() // quem já absorveu alguém desta fonte
  const out: MergeDecision[] = []
  for (const loser of ordered) {
    if (absorbed.has(loser.id)) continue
    let best: SaleLike | null = null
    let bestDt = Number.POSITIVE_INFINITY
    for (const winner of ordered) {
      if (winner.id === loser.id || absorbed.has(winner.id)) continue
      if (sourceRank(winner.source) >= sourceRank(loser.source)) continue
      if (used.has(`${winner.id}|${loser.source}`)) continue
      if (!isSameSale(winner, loser)) continue
      const dt = Math.abs(new Date(winner.occurredAt).getTime() - new Date(loser.occurredAt).getTime())
      if (dt < bestDt) {
        best = winner
        bestDt = dt
      }
    }
    if (best) {
      absorbed.add(loser.id)
      used.add(`${best.id}|${loser.source}`)
      out.push({ keep: best, merge: loser })
    }
  }
  return out
}
