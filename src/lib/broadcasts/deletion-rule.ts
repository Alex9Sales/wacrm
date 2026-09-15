// ============================================================
// "Excluir" um disparo: apagar de verdade × arquivar. Puro (sem banco/fila).
//
// 15/09 (GoLink): o "dia do cliente" foi excluído depois de sair e levou o
// histórico junto. A 1ª correção apagava quando sent_count = 0 e todos os
// destinatários ainda estavam 'pending' — mas o 1º envio de um disparo
// 'sending' fica 'pending' com attempts = 0 ENQUANTO o worker manda (o job
// está ativo; attempts/status só mudam depois da resposta do provedor). A
// exclusão cancelava, via "nada saiu", apagava — e o cliente recebia a
// mensagem de um disparo que sumiu (revisão 15/09).
//
// Regra: apagar só o que comprovadamente nunca tentou enviar.
//   - rascunho ou agendado (o worker ainda não pegou);
//   - cancelado sem nenhuma tentativa (attempts > 0) e sem job ativo.
// Esteve enviando/pausado (ou já terminou), tem alguém tentado, enviado ou
// falhado, ou há job saindo agora → ARQUIVA (some da lista, o histórico fica).
// ============================================================

/** Status (antes de excluir) em que ainda pode apagar de verdade. */
export const DELETABLE_PREVIOUS_STATUSES: readonly string[] = ['draft', 'scheduled', 'cancelled']

export function broadcastDeleteOrArchive(i: {
  /** Status que o disparo tinha logo antes da exclusão (antes de cancelar). */
  previousStatus: string | null | undefined
  sentCount: number | null | undefined
  /** Destinatários com status diferente de 'pending' (enviado/falhou/…). */
  nonPendingCount: number | null | undefined
  /** Destinatários com attempts > 0 (o worker já tentou mandar). */
  attemptedCount: number | null | undefined
  /** Algum job deste disparo ativo na fila (ou não deu pra saber). */
  activeJob: boolean
}): 'delete' | 'archive' {
  if (i.activeJob) return 'archive'
  if ((i.sentCount ?? 0) > 0) return 'archive'
  if ((i.nonPendingCount ?? 0) > 0) return 'archive'
  if ((i.attemptedCount ?? 0) > 0) return 'archive'
  if (!i.previousStatus || !DELETABLE_PREVIOUS_STATUSES.includes(i.previousStatus)) return 'archive'
  return 'delete'
}
