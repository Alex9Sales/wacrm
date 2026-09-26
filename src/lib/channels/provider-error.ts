// ============================================================
// Erro de provider → frase útil pro atendente.
//
// 25/09, teste do Alex no Instagram: reagir a uma conversa parada há 17 dias
// devolveu na tela "Falha na reação: Meta API error: instagram send falhou:
// 403 Essa mensagem foi enviada fora do período permitido." Três prefixos
// empilhados pelos adaptadores, e só a última parte diz alguma coisa a quem
// está atendendo — que ainda assim não sabe o que fazer com ela.
//
// A janela de 24h ganha nome próprio porque é a recusa mais comum e tem
// solução conhecida: mandar um template para reabrir a conversa. O texto cru
// continua indo pro log; aqui é o que a pessoa lê.
// ============================================================

/** A Meta recusou por estar fora da janela de 24h? */
export function isOutsideWindowError(raw: string): boolean {
  return /fora do per[ií]odo permitido|outside the allowed window|outside of the allowed window|\(#10\)/i.test(
    raw,
  )
}

export const OUTSIDE_WINDOW_MESSAGE =
  'A janela de 24 horas fechou: o canal não aceita reação depois que o cliente fica um dia sem escrever. Mande um template para reabrir a conversa.'

/**
 * ⚠️ 25/09, medido na conta do Alex: o Instagram recusa qualquer reação que
 * não seja o coração. 👍 devolveu 400 "Reação inválida"; a doc da Meta mostra
 * `"reaction": "love"` como único exemplo e não lista alternativas. Quem está
 * atendendo precisa saber disso na hora, senão tenta de novo com outro emoji.
 */
export const IG_ONLY_HEART_MESSAGE =
  'O Instagram só aceita ❤️ como reação enviada pelo CRM — os outros emojis a Meta recusa. Reaja com o coração, ou responda a mensagem.'

/** 500 da Meta: não é nosso e não tem o que corrigir na hora. */
export const PROVIDER_FLAKY_MESSAGE =
  'O canal respondeu com erro interno e pediu para tentar de novo daqui a pouco. Não é a sua reação: se insistir e continuar, me avise.'

export function humanProviderError(raw: string): string {
  // O adaptador anexa "[code=… subcode=… fbtrace_id=…]" no fim para o LOG e
  // para abrir chamado com a Meta. Isso não vai pra tela do atendente.
  const texto = (raw ?? '').replace(/\s*\[(?:code|subcode|fbtrace_id)=[^\]]*\]\s*$/i, '').trim()
  if (!texto) return 'O canal recusou a ação e não disse o motivo.'
  if (isOutsideWindowError(texto)) return OUTSIDE_WINDOW_MESSAGE
  if (/rea[çc][ãa]o inv[áa]lida|invalid reaction/i.test(texto)) {
    return IG_ONLY_HEART_MESSAGE
  }
  // 5xx só quando é CÓDIGO (no começo ou logo após o prefixo do adaptador) ou
  // quando a Meta diz em palavras. `\b5\d{2}\b` sozinho transformaria
  // "pedido 500 itens" em "erro interno do canal".
  if (/(?:^|falhou:\s*)5\d{2}\b|unexpected error has occurred/i.test(texto)) {
    return PROVIDER_FLAKY_MESSAGE
  }

  // Corta o prefixo dos adaptadores ("instagram send falhou: 400 ") ou um
  // código HTTP logo no começo, ficando com o texto que a Meta escreveu.
  //
  // ⚠️ Estreito de propósito: um `\b[45]\d{2}\b` solto casaria com qualquer
  // número no meio da frase e devolveria "o pedido 500 não foi encontrado"
  // como "não foi encontrado". Sem prefixo reconhecido, não se corta nada.
  const semPrefixo = texto
    .replace(/^.*?\bfalhou:\s*[45]\d{2}\s+/i, '')
    .replace(/^[45]\d{2}\s+/, '')
    .trim()
  return semPrefixo || texto
}
