// ============================================================
// 📨 "Eu entreguei, só não consegui anotar."
//
// 30/09/2026, em produção. O lembrete de reunião do Alex saiu ÀS 15:00 para o
// Rafael. O WhatsApp aceitou (veio o id `3EB0B081…`, status `sent`), mas o
// INSERT em `messages` falhou logo depois — e `engineSendText` lançou. Quem
// chamou leu a exceção como "não enviei", tentou de novo no tick seguinte, e o
// Rafael recebeu a MESMA mensagem duas vezes, com um minuto de diferença.
//
// A falha é de leitura: "a chamada lançou" não é o mesmo que "a mensagem não
// chegou". Entre falar com o provedor e gravar no banco existe um intervalo em
// que a mensagem já é do cliente e ainda não é nossa. Retentar aí é escrever de
// novo para uma pessoa que já leu.
//
// Antes isto passava despercebido porque o chamador carimbava o envio de
// qualquer jeito — o efeito colateral de um bug encobria o outro. Ao consertar
// o carimbo (não dar por enviado o que não saiu), este ficou à mostra.
//
// A regra: quem for retentar um envio PRECISA perguntar antes se ele já foi
// entregue. É por isso que isto é um tipo, e não um texto de mensagem de erro
// para alguém comparar com `includes()`.
// ============================================================

/**
 * O provedor ACEITOU a mensagem, mas não conseguimos registrá-la.
 *
 * O cliente recebeu. O histórico do CRM é que ficou incompleto. Nunca retente
 * um envio que falhou assim: trate como enviado e, se possível, conserte o
 * registro.
 */
export class DeliveredButNotRecordedError extends Error {
  /** Marca estrutural — sobrevive a serialização e a `instanceof` entre bundles. */
  readonly delivered = true as const

  constructor(
    /** Id que o provedor devolveu, quando houve — é a prova da entrega. */
    readonly externalMessageId: string | null,
    /** O erro de gravação, para o log. */
    readonly causa: string,
  ) {
    // Mantém o texto histórico: há logs e buscas que procuram por ele.
    super(`sent to provider but DB insert failed: ${causa}`)
    this.name = 'DeliveredButNotRecordedError'
  }
}

/**
 * Esta exceção significa que o cliente JÁ RECEBEU a mensagem?
 *
 * Aceita tanto a classe quanto a marca `delivered`, porque o erro pode
 * atravessar uma fila (BullMQ) e chegar do outro lado como objeto simples, sem
 * o protótipo. O `includes` na mensagem é o último recurso, para os lugares que
 * ainda lançam Error cru.
 */
export function jaFoiEntregue(err: unknown): boolean {
  if (err instanceof DeliveredButNotRecordedError) return true
  if (typeof err === 'object' && err !== null && 'delivered' in err) {
    return (err as { delivered?: unknown }).delivered === true
  }
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return msg.includes('sent to provider but DB insert failed')
}
