// ============================================================
// Follow-up que repete o que a IA já disse. 19/09 (Rafael): a IA respondeu
// "Combinado, Celso. Na segunda, me diga se conseguiu importar…" e, uma hora
// depois, o reengajamento mandou a MESMA frase. O prompt já pedia pra não
// repetir; instrução não basta — aqui a comparação é no código.
// Puro (sem banco): dá pra testar.
// ============================================================

/** Texto comparável: sem caixa, acento, emoji e pontuação. */
export function normalizeForEcho(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * O texto novo é eco de alguma das últimas mensagens enviadas? Igual depois de
 * normalizar, ou uma contida na outra com tamanho parecido (o modelo às vezes
 * repete a frase e troca só o "Combinado" do começo).
 */
export function isEchoOfRecent(text: string, recentOutbound: string[]): boolean {
  const novo = normalizeForEcho(text)
  if (novo.length < 12) return false
  for (const prev of recentOutbound) {
    const velho = normalizeForEcho(prev)
    if (!velho) continue
    if (velho === novo) return true
    const [curto, longo] = novo.length <= velho.length ? [novo, velho] : [velho, novo]
    if (longo.includes(curto) && curto.length / longo.length >= 0.8) return true
  }
  return false
}
