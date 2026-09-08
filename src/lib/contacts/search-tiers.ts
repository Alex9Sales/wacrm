// ============================================================
// Camadas da busca por NOME (parte pura de lib/contacts/search.ts).
//
// O dono escreve "Danyela Souza"; o contato está salvo só como "Danyela"
// (caso 08/09). Frase inteira não acha → tenta todas as palavras → tenta só o
// primeiro nome. A ambiguidade continua visível: se o primeiro nome devolver
// vários, o fluxo lista pra escolher — nunca chuta.
// ============================================================

export function nameSearchTiers(term: string): string[][] {
  const clean = term.replace(/[%_]/g, '').trim()
  if (!clean) return []
  const words = clean.split(/\s+/).filter((w) => w.length >= 2)
  const tiers: string[][] = [[clean]]
  if (words.length > 1) {
    tiers.push(words)
    const first = words[0]
    if (first && first.length >= 3) tiers.push([first])
  }
  return tiers
}
