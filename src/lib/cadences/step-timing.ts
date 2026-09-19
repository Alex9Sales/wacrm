// ============================================================
// Tempo dos toques de uma cadência — puro, usado pelo motor (agendar) e pelo
// editor (avisos). Cada toque sai N min/h/dias depois do INÍCIO da cadência,
// não do toque anterior (26/08). Quem monta pensando "2 dias depois do
// anterior" põe +2d em vários toques e eles saem JUNTOS, às vezes fora de
// ordem (19/09, Rafael: 4 toques da Masterclass no mesmo minuto).
// ============================================================

/** Atraso de um toque em ms (min/horas/dias; negativo vira 0). */
export function delayMsOf(value: number, unit: string): number {
  const v = Math.max(0, Number(value) || 0)
  if (unit === 'minutes') return v * 60_000
  if (unit === 'hours') return v * 3_600_000
  return v * 86_400_000 // days
}

export interface StepTimingIssue {
  /** Outros toques (índices da lista) que saem no MESMO horário deste. */
  sameTimeAs: number[]
  /** 1º toque ANTERIOR na lista que sai DEPOIS deste (índice), ou null. */
  before: number | null
}

/** Avisos de tempo por toque, na ordem da lista (sem aviso = listas vazias/null). */
export function stepTimingIssues(steps: { delayValue: number; delayUnit: string }[]): StepTimingIssue[] {
  const ms = steps.map((s) => delayMsOf(s.delayValue, s.delayUnit))
  return ms.map((t, i) => {
    const sameTimeAs = ms.flatMap((u, j) => (j !== i && u === t ? [j] : []))
    const later = ms.slice(0, i).findIndex((u) => u > t)
    return { sameTimeAs, before: later === -1 ? null : later }
  })
}
