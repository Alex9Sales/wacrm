// ============================================================
// A IA disse que FEZ — mas fez mesmo?
//
// 26/09, Família do Gás. A Maria consultou cliente, última compra e estoque,
// montou a proposta ("Fecho assim, Thiago? 1 Ultragaz por R$ 130,00..."), o
// cliente respondeu "Obrigado" e ela respondeu:
//
//   "Pedido confirmado, Thiago! 😊 O entregador já está a caminho."
//
// `criar_pedido` NUNCA foi chamada. Não houve erro de ferramenta: ela
// simplesmente não a chamou. O pedido não existe no CRM nem no ERP, e o
// cliente está em casa esperando um entregador que ninguém acionou. No mesmo
// dia, dois outros pedidos (Isabel, Vania) foram criados normalmente pela
// mesma ferramenta — ou seja, o caminho funciona.
//
// Em 7 dias isso aconteceu 2x (Thiago 26/09, Jonathan 25/09). Raro, e caro:
// pior do que perder a venda é prometer entrega que não foi pedida.
//
// ⚠️ POR QUE ISSO É CÓDIGO E NÃO PROMPT: já perdemos 8 pedidos em 7 dias por
// confiar que o prompt garantiria o comportamento da ferramenta (ver
// crmfluxia-agente-erra-uuid-ferramenta). Instrução reduz a chance; não
// elimina. A rede que pega o que escapa tem que ser determinística.
// ============================================================

/**
 * Frases em que a IA afirma que uma ação JÁ FOI concluída — não "vou fazer",
 * não "posso fazer", mas "está feito". Deliberadamente estreito: só o que, se
 * for mentira, deixa alguém esperando. Ampliar isto sem medir vira alarme
 * falso, e alarme falso treina o dono a ignorar a nota.
 */
const AFIRMACOES = [
  /pedido\s+(?:foi\s+)?(?:confirmado|registrado|realizado|feito|gerado)/i,
  /entregador\s+(?:j[áa]\s+)?(?:est[áa]|vai|saiu|foi)\s+(?:a\s+caminho|indo|sa[ií]ndo)/i,
  /j[áa]\s+(?:mandei|chamei|acionei|enviei)\s+o\s+entregador/i,
  /(?:j[áa]\s+)?(?:deixei|est[áa])\s+(?:tudo\s+)?(?:registrado|lan[çc]ado)\s+no\s+sistema/i,
]

/** A resposta afirma que uma ação foi concluída? */
export function claimsCompletedAction(text: string | null | undefined): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  return AFIRMACOES.some((re) => re.test(t))
}

export interface GhostCheck {
  /** O texto que a IA mandou ao cliente. */
  text: string | null | undefined
  /** Alguma ferramenta de ESCRITA gravou algo neste turno? */
  wroteSomething: boolean
  /** Houve escrita bem-sucedida nesta conversa há pouco (turno anterior)? */
  wroteRecently: boolean
}

/**
 * Promessa sem lastro: a IA afirmou que fez, e nada foi gravado — nem neste
 * turno, nem no anterior.
 *
 * `wroteRecently` existe para o caso legítimo em que o cliente pergunta
 * "confirmou mesmo?" e a IA repete a confirmação de um pedido criado minutos
 * antes. Sem essa folga, toda repetição viraria alarme falso.
 */
export function isGhostConfirmation(c: GhostCheck): boolean {
  if (c.wroteSomething || c.wroteRecently) return false
  return claimsCompletedAction(c.text)
}

export const GHOST_NOTE =
  '⚠️ A IA disse ao cliente que o pedido está confirmado, mas NÃO registrou pedido nenhum (nenhuma ferramenta de escrita rodou). O cliente pode estar esperando entrega que ninguém lançou. Confira e lance o pedido, ou avise o cliente.'
