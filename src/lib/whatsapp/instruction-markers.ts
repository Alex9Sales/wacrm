// ============================================================
// 🛡️ Marcador de instrução nunca chega ao cliente.
//
// 29/09 (Zelo). A Aline, lead de franquia, recebeu:
//
//   "…e o modelo do negócio. Você terá 10 dias para analisar tudo com calma.
//    [[ENVIAR: Circular de Oferta de Franquia]]"
//
// O marcador cru, à mostra — e sem o documento. Ele é a linguagem interna
// entre o prompt e o motor: o prompt da Zélia manda escrever
// `[[ENVIAR:<nome>]]`, e o motor deveria trocar isso pelo arquivo.
//
// O motor JÁ tinha uma rede que limpa marcador desconhecido. O problema é
// onde ela mora: dentro do auto-reply. Todo outro caminho de envio — um
// rascunho da IA que um humano aceita e manda, uma integração, uma automação
// futura — escapa dela. Rede de segurança só serve se estiver no lugar por
// onde todos passam, e o lugar é o envio.
//
// AQUI SÓ SE REMOVE. Entregar o material exige o catálogo do agente, que o
// envio não conhece. Texto sem o anexo é uma falha; texto com "[[ENVIAR:…]]"
// visível é a mesma falha MAIS a sensação de sistema quebrado para quem lê.
// Quem chama registra o que removeu, para que o material que não foi tenha
// rastro em vez de sumir.
//
// Sem 'server-only': o worker alcança este arquivo.
// ============================================================

/**
 * Qualquer `[[…]]` é marcador interno, com DUAS exceções que são conteúdo de
 * verdade e já circulam assim: `[[AUDIO]]` (o pedido de responder em voz) e
 * `[[foto:…]]`. A regra é "tudo é interno, menos o que se conhece" de
 * propósito — marcador novo que alguém inventar no prompt amanhã já nasce
 * bloqueado, em vez de vazar até alguém reparar.
 */
const INSTRUCTION_MARKER = /\[\[(?!\s*(?:audio\s*\]\]|foto\s*:))[\s\S]*?\]\]/gi

export interface StrippedText {
  /** O texto que pode ir ao cliente. */
  text: string | null
  /** Os marcadores retirados, como vieram — para o log. */
  removed: string[]
}

export function stripInstructionMarkers(raw: string | null | undefined): StrippedText {
  if (typeof raw !== 'string' || !raw) return { text: raw ?? null, removed: [] }

  const removed: string[] = []
  // Decide LINHA A LINHA, como o parser de materiais do motor já faz: a linha
  // que era só o marcador some inteira; a que tinha texto fica, sem o buraco.
  // Um filtro global de linhas vazias comeria parágrafo legítimo.
  const linhas = raw.split('\n')
  const mantidas: string[] = []
  for (const linha of linhas) {
    let tinha = false
    // Uma instância por linha: regex com /g guarda lastIndex, e reaproveitar
    // a mesma faria a linha seguinte começar a busca no meio.
    const re = new RegExp(INSTRUCTION_MARKER.source, 'gi')
    const semMarcador = linha.replace(re, (m) => {
      tinha = true
      removed.push(m.trim())
      return ''
    })
    if (tinha && !semMarcador.trim()) continue // linha que era só o marcador
    mantidas.push(tinha ? semMarcador.replace(/[ \t]{2,}/g, ' ').trimEnd() : linha)
  }
  if (!removed.length) return { text: raw, removed: [] }

  const text = mantidas.join('\n').replace(/\n{3,}/g, '\n\n').trim()

  return { text, removed }
}
