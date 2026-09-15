// ============================================================
// Rastro das ações em disparos — tabela broadcast_events (migr 0174) + uma
// linha JSON no log por ação.
//
// 15/09 (GoLink): o "dia do cliente" foi pausado, cancelado e excluído e não
// havia como saber quem clicou (sem log de acesso). A primeira versão só
// escrevia no console — e os logs somem a cada deploy (revisão 15/09). Agora
// grava no banco: quem, o quê, qual disparo, status anterior, qual canal,
// quantos já tinham saído. Sem FK pra broadcasts: o evento de exclusão
// sobrevive à linha apagada. Sem conteúdo da mensagem.
//
// Best-effort: NUNCA lança — o rastro não pode desfazer nem travar a ação
// (pausar/cancelar/excluir já aconteceu quando isto roda). Sem `server-only`:
// broadcast-controls (que o worker importa) chama daqui.
// ============================================================

import { db, broadcastEvents } from '@/db'

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

export interface BroadcastAuditEvent {
  action: BroadcastAuditAction
  broadcastId: string
  accountId: string
  userId: string | null
  /** Papel na conta, ou 'api_key'/'api' quando veio pela API. */
  role?: string | null
  /** Status do disparo logo antes da ação, quando quem chama sabe. */
  previousStatus?: string | null
  channelId?: string | null
  sentCount?: number | null
  extra?: Record<string, unknown>
}

/** Transação do Drizzle de quem chama (ex.: evento + DELETE juntos). */
export type BroadcastAuditTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function logBroadcastEvent(
  event: BroadcastAuditEvent,
  opts: { tx?: BroadcastAuditTx } = {},
): Promise<void> {
  try {
    console.info('[broadcast-audit]', JSON.stringify({ ...event, at: new Date().toISOString() }))
  } catch {
    /* nunca atrapalha a ação */
  }

  try {
    const row = {
      accountId: event.accountId,
      broadcastId: event.broadcastId,
      userId: event.userId ?? null,
      role: event.role ?? null,
      action: event.action,
      previousStatus: event.previousStatus ?? null,
      channelId: event.channelId ?? null,
      sentCount: event.sentCount ?? null,
      extra: event.extra ?? null,
    }
    if (opts.tx) {
      // Dentro da transação de quem chama, num SAVEPOINT: um INSERT que falha
      // aborta só o savepoint — sem isso o Postgres abortaria a transação
      // inteira e a exclusão (que o evento acompanha) falharia junto.
      await opts.tx.transaction(async (sp) => {
        await sp.insert(broadcastEvents).values(row)
      })
    } else {
      await db.insert(broadcastEvents).values(row)
    }
  } catch (err) {
    console.error(
      '[broadcast-audit] não gravou o evento:',
      event.action,
      event.broadcastId,
      err instanceof Error ? err.message : err,
    )
  }
}
