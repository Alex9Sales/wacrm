// ============================================================
// O resumo do pedido que vai pro card e pro aviso do despacho.
//
// 28/09 (Família do Gás): a Maria fechou uma venda e o aviso "PEDIDO
// CONFIRMADO PELA IA" saiu no formato "1 botijão · <bairro> · dinheiro · troco
// para R$ 200" — bairro sim, RUA E NÚMERO não. O entregador não tinha pra onde
// ir.
//
// O endereço NÃO se perdeu: `agent_tool_runs` mostra que ele foi inteiro no
// `criar_pedido`, e o pedido no sistema da loja está correto. O que se perdeu
// foi no caminho até o card: o `[[CRIARCARD]]` que o modelo escreve cria o
// card primeiro (e dispara o aviso), e a nota derivada dos ARGUMENTOS da
// ferramenta chegava depois, quando `createDealFromAi` já reaproveitava o card
// da conversa e descartava a nota nova.
//
// Ou seja: o resumo dependia de a IA LEMBRAR de repetir o endereço no
// marcador. Os argumentos são a verdade — foram pro sistema da loja — então
// eles completam o que o texto do modelo não disse, sem repetir o que disse.
// ============================================================

export interface OrderFields {
  obs: string
  endereco: string
  bairro: string
  pagamento: string
}

/** Tipo de via na frente do nome não é parte do endereço pra fim de comparação:
 *  a IA escreve "Rua Clades Anna, 182" e a ferramenta recebe "clades anna 182". */
const VIA = /^(?:r|rua|av|avenida|al|alameda|tv|travessa|rod|rodovia|pc|praca|est|estrada)\s+/

/** Achata pra comparar: sem acento, sem pontuação, minúsculo, espaço único. */
function chave(v: string): string {
  return v
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(VIA, '')
}

/** O texto do modelo já disse isso? Compara por conteúdo, não por formato. */
function jaDito(notaDoModelo: string, valor: string): boolean {
  const alvo = chave(valor)
  if (!alvo) return true // nada a acrescentar
  return chave(notaDoModelo).includes(alvo)
}

/**
 * Junta o resumo do modelo com os dados reais do pedido.
 *
 * O que o modelo escreveu vem primeiro (é a leitura humana da venda: produto,
 * troco, combinados); o que ele esqueceu entra rotulado no fim. Campo que ele
 * já disse NÃO repete — rua e bairro são testados separados justamente porque
 * o caso comum é o bairro estar lá e a rua não.
 *
 * Sem dados do pedido devolve o texto do modelo; sem texto do modelo, monta o
 * resumo só com os dados — nunca devolve string vazia no lugar de null.
 */
export function mergeOrderNote(
  notaDoModelo: string | null | undefined,
  fields: OrderFields | null | undefined,
): string | null {
  const base = (notaDoModelo ?? '').trim()
  if (!fields) return base || null

  const { obs, endereco, bairro, pagamento } = fields
  const pedacos: string[] = []
  const falta = (v: string) => !!v.trim() && !jaDito(base, v)

  if (falta(obs)) pedacos.push(obs.trim())
  // Rótulo no endereço porque ele entra no fim de uma frase já formada —
  // "… · troco para R$ 200 · clades anna 182" não se lê como endereço.
  if (falta(endereco)) {
    pedacos.push(`endereço: ${[endereco.trim(), falta(bairro) ? bairro.trim() : ''].filter(Boolean).join(', ')}`)
  } else if (falta(bairro)) {
    pedacos.push(`bairro: ${bairro.trim()}`)
  }
  if (falta(pagamento)) pedacos.push(`pagamento: ${pagamento.trim()}`)

  return [base || null, ...pedacos].filter(Boolean).join(' · ') || null
}
