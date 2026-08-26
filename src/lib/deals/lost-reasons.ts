// Motivos de perda — helpers PUROS (client-safe, sem db). Comparação
// canônica: sem caixa e sem acento, pra "Não responde" ≡ "nao responde"
// nunca virarem dois motivos (duplicata que dividia o relatório do Rafael).

/** Forma canônica de um motivo pra comparação: trim + minúsculas + sem acento. */
export function canonReason(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

/** Dedupe preservando a PRIMEIRA grafia de cada motivo (ordem mantida). */
export function dedupeReasons(reasons: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of reasons) {
    const t = r.trim()
    if (!t) continue
    const c = canonReason(t)
    if (seen.has(c)) continue
    seen.add(c)
    out.push(t)
  }
  return out
}
