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
 *
 * Só dentro da LINHA (`[^\n]`): um "[[" solto de texto comum não pode ir até
 * um "]]" lá embaixo e comer os parágrafos do meio. Marcador que atravessa
 * linhas só é removido quando tem nome conhecido (ver MARCADOR_DE_CONTROLE).
 */
const MARCADOR_GENERICO = String.raw`\[\[(?!\s*(?:audio\s*\]\]|foto\s*:))[^\n]*?\]\]`

/**
 * Nomes de marcador que o sistema usa — conferidos em ai/defaults.ts (as
 * diretivas), ai/materials-shared.ts (ENVIAR), ai/external-tools.ts
 * (FERRAMENTA), ai/followup.ts (SILENT) e na captura do site (LEAD). Marcador
 * NOVO entra aqui também: sem o nome, a versão mal fechada dele vaza.
 * AUDIO e foto ficam de fora pelo mesmo motivo do MARCADOR_GENERICO.
 */
const NOMES_DE_MARCADOR = [
  'resumo',
  'handoff',
  'transferir',
  'agente',
  'avisardono',
  'agendar',
  'perder',
  'ganho',
  'funil',
  'resolver',
  'ignorar',
  'etiqueta',
  'criarcard',
  'nota',
  'atributo',
  'voz',
  'telefone',
  'cobran[cç]a',
  'cobrar',
  'enviar',
  'ferramenta',
  'silent',
  'lead',
]

/** Os que nunca levam argumento: o 1º "]" já fecha ("[[GANHO] Obrigado!"
 *  perde só o marcador, não a frase). */
const SEM_ARGUMENTO = ['handoff', 'ganho', 'resolver', 'ignorar', 'silent']

/**
 * 🛡️ Marcador de controle MAL FECHADO (02/10/2026, conta com agente OpenAI).
 *
 * Numa transferência o modelo escreveu "[[HANDOFF]]" e, na linha de baixo,
 * "[[RESUMO:Cliente quer … as medidas.] ]" — fechado com colchete, ESPAÇO,
 * colchete. O MARCADOR_GENERICO só reconhece "[[…]]" fechado, então o resumo
 * para a equipe, com os dados do cliente, foi ENVIADO como despedida.
 *
 * Mal fechado só é reconhecível pelo NOME: "[[" + um nome desta lista vai até
 * o primeiro "]" + espaços/quebra opcionais + "]", ou até antes do próximo
 * "[[", ou até o FIM do texto — atravessando linhas (o resumo às vezes vem em
 * várias). Perder o resto de uma resposta que já estava quebrada é melhor que
 * mandar o encanamento ao cliente. "[[" sem nome conhecido (texto comum, o
 * colchete do próprio cliente) não é mexido: sem nome não dá para saber onde
 * acaba, e engolir texto de verdade seria outra falha.
 *
 * O nome tem que terminar ali ("[[NOTAS…" não é NOTA). Vale também para o
 * marcador BEM fechado, que é removido igual.
 */
const MARCADOR_DE_CONTROLE =
  String.raw`\[\[\s*(?:(?:${SEM_ARGUMENTO.join('|')})\s*\](?:\s*\])?|` +
  String.raw`(?:${NOMES_DE_MARCADOR.join('|')})(?![\p{L}\p{N}_])(?:(?!\[\[)[\s\S])*?(?:\]\s*\](?!\])|(?=\[\[)|$))`

/**
 * Regex NOVA a cada chamada (com /g, uma instância compartilhada guardaria o
 * lastIndex entre textos). Para o auto-reply, que limpa o texto inteiro
 * antes da decisão "tem texto?" e precisa da mesma regra deste envio.
 */
export function controlMarkerRegex(): RegExp {
  return new RegExp(MARCADOR_DE_CONTROLE, 'giu')
}

/** O conhecido vem ANTES na alternância: o genérico iria do "[[RESUMO" mal
 *  fechado até o "]]" de outro marcador e comeria o texto do meio. */
function marcadoresRegex(): RegExp {
  return new RegExp(`${MARCADOR_DE_CONTROLE}|${MARCADOR_GENERICO}`, 'giu')
}

/** Marca o lugar de onde um marcador saiu, para a limpeza linha a linha.
 *  NUL não aparece em mensagem de WhatsApp. */
const VAGA = '\u0000'

export interface StrippedText {
  /** O texto que pode ir ao cliente. */
  text: string | null
  /** Os marcadores retirados, como vieram — para o log. */
  removed: string[]
}

export function stripInstructionMarkers(raw: string | null | undefined): StrippedText {
  if (typeof raw !== 'string' || !raw) return { text: raw ?? null, removed: [] }

  // Remove no texto INTEIRO (um marcador mal fechado atravessa linhas) e deixa
  // uma VAGA no lugar; a arrumação depois é por linha.
  const removed: string[] = []
  const marcado = raw.replace(marcadoresRegex(), (m) => {
    removed.push(m.trim())
    return VAGA
  })
  if (!removed.length) return { text: raw, removed: [] }

  // Decide LINHA A LINHA, como o parser de materiais do motor já faz: a linha
  // que era só o marcador some inteira; a que tinha texto fica, sem o buraco.
  // Um filtro global de linhas vazias comeria parágrafo legítimo.
  const mantidas: string[] = []
  for (const linha of marcado.split('\n')) {
    if (!linha.includes(VAGA)) {
      mantidas.push(linha)
      continue
    }
    const semMarcador = linha.split(VAGA).join('')
    if (!semMarcador.trim()) continue // linha que era só o marcador
    mantidas.push(semMarcador.replace(/[ \t]{2,}/g, ' ').trimEnd())
  }

  const text = mantidas.join('\n').replace(/\n{3,}/g, '\n\n').trim()

  return { text, removed }
}
