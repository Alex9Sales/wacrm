// ============================================================
// Rastro das ações em disparos — uma linha JSON no log por ação.
//
// 15/09 (GoLink): o "dia do cliente" foi pausado, cancelado e excluído e não
// havia como saber quem clicou (sem log de acesso, e os logs somem a cada
// deploy). Aqui fica o mínimo pra suporte: quem, o quê, qual disparo, qual
// canal, quantos já tinham saído. Nunca lança; sem conteúdo da mensagem.
// ============================================================

export type BroadcastAuditAction =
  | 'create'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retry'
  | 'delete'
  | 'archive'
  | 'remove_recipient'
  | 'send_now'

export function logBroadcastEvent(event: {
  action: BroadcastAuditAction
  broadcastId: string
  accountId: string
  userId: string | null
  role?: string | null
  channelId?: string | null
  sentCount?: number | null
  extra?: Record<string, unknown>
}): void {
  try {
    console.info('[broadcast-audit]', JSON.stringify({ ...event, at: new Date().toISOString() }))
  } catch {
    /* nunca atrapalha a ação */
  }
}
