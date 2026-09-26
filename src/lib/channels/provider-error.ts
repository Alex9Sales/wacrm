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

export function humanProviderError(raw: string): string {
  const texto = (raw ?? '').trim()
  if (!texto) return 'O canal recusou a ação e não disse o motivo.'
  if (isOutsideWindowError(texto)) return OUTSIDE_WINDOW_MESSAGE

  // Corta tudo até o código HTTP, ficando com o texto que a Meta escreveu.
  // Sem o código não há o que cortar — devolve como veio, nunca vazio.
  const semPrefixo = texto.replace(/^.*?\b[45]\d{2}\s+/, '').trim()
  return semPrefixo || texto
}
