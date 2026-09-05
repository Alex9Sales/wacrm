// ============================================================
// 🧾 Variação das mensagens de cobrança (item 2 da auditoria de 05/09).
//
// Pedido literal do cliente pagante: "os envios não podem ser robotizados,
// cada mensagem tem que ser diferente". Três peças, todas puras:
//   1. um PLANO de variação por mensagem (abertura, corpo, fechamento,
//      tamanho, emoji) sorteado por semente — dois devedores no mesmo dia, ou
//      o mesmo devedor em dois toques, recebem instruções diferentes;
//   2. SIMILARIDADE entre textos ignorando o que é obrigatoriamente igual
//      (valores, datas, link) — é o que decide se a IA repetiu;
//   3. semente determinística (contato + toque + dia) para o sorteio ser
//      reproduzível em teste e estável dentro do mesmo dia.
// ============================================================

/** FNV-1a 32 bits: semente estável a partir de pedaços (contato, toque, dia). */
export function seedFrom(...parts: (string | number)[]): number {
  let h = 0x811c9dc5
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

const OPENINGS = [
  'Comece cumprimentando pelo primeiro nome, em uma frase só.',
  'Comece direto pelo assunto, sem cumprimento.',
  'Comece com uma frase curta de contexto ("passando por aqui rapidinho", "dando um toque").',
  'Comece perguntando se está tudo bem, e só depois entre no assunto.',
  'Comece agradecendo a atenção.',
  'Comece mencionando o momento do envio (dia da semana ou período do dia), se ele foi informado.',
]
const BODIES = [
  'Apresente as parcelas em linhas separadas.',
  'Apresente as parcelas numa frase corrida, sem lista.',
  'Diga primeiro o total e só depois o detalhe das parcelas.',
]
const CLOSINGS = [
  'Termine perguntando se o pagamento já foi feito.',
  'Termine oferecendo combinar uma data por ali mesmo.',
  'Termine pedindo para responder qualquer dúvida por aqui.',
  'Termine com uma frase curta de disponibilidade ("qualquer coisa é só chamar").',
  'Termine convidando a responder com "já paguei" ou com uma data.',
]
const LENGTHS = ['Tamanho: curta, 2 a 3 frases.', 'Tamanho: média, 4 a 5 frases.']
const EMOJIS = ['Sem emoji.', 'No máximo 1 emoji, no fim.']

export interface VariationPlan {
  opening: string
  body: string
  closing: string
  length: string
  emoji: string
}

/** Sorteio determinístico: a mesma semente sempre dá o mesmo plano. */
export function variationPlan(seed: number): VariationPlan {
  const s = seed >>> 0
  return {
    opening: OPENINGS[s % OPENINGS.length],
    body: BODIES[(s >>> 3) % BODIES.length],
    closing: CLOSINGS[(s >>> 6) % CLOSINGS.length],
    length: LENGTHS[(s >>> 9) % LENGTHS.length],
    emoji: EMOJIS[(s >>> 10) % EMOJIS.length],
  }
}

export function variationInstruction(plan: VariationPlan): string {
  return ['Jeito desta mensagem (siga):', `- ${plan.opening}`, `- ${plan.body}`, `- ${plan.closing}`, `- ${plan.length}`, `- ${plan.emoji}`].join('\n')
}

/**
 * Tokens comparáveis: minúsculas, sem acento, sem URL, sem número (valor, data
 * e link são iguais por obrigação — não contam como repetição), sem palavras
 * curtíssimas.
 */
export function compareTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\d.,:/-]+/g, ' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 3)
}

function bigrams(tokens: string[]): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + 1 < tokens.length; i++) out.add(`${tokens[i]} ${tokens[i + 1]}`)
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** 0 = nada a ver · 1 = igual. Bigramas de palavras; unigramas quando o texto é curto demais. */
export function textSimilarity(a: string, b: string): number {
  const ta = compareTokens(a)
  const tb = compareTokens(b)
  const ba = bigrams(ta)
  const bb = bigrams(tb)
  if (ba.size >= 3 && bb.size >= 3) return jaccard(ba, bb)
  return jaccard(new Set(ta), new Set(tb))
}

export function maxSimilarity(candidate: string, previous: string[]): number {
  let m = 0
  for (const p of previous) m = Math.max(m, textSimilarity(candidate, p))
  return m
}

/** Limiar: duas cobranças legítimas sobre a mesma dívida partilham algo ("valor em aberto", "link de pagamento") — só acima disso é cópia. */
export const SIMILARITY_LIMIT = 0.5

export function tooSimilar(candidate: string, previous: string[], limit = SIMILARITY_LIMIT): boolean {
  return previous.length > 0 && maxSimilarity(candidate, previous) >= limit
}
