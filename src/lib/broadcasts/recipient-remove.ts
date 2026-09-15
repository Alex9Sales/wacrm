// ============================================================
// Tirar UM destinatário de um disparo que ainda não mandou pra ele.
//
// 15/09 (GoLink): pra tirar 2 pessoas da fila (já tinham recebido à mão), a
// única saída era cancelar e refazer o disparo inteiro — o que gerou envios
// repetidos.
//
// Ordem importa: primeiro tira o job da fila do canal (jobId = id do
// destinatário) e só depois apaga a linha com WHERE status='pending' — assim o
// envio não sai nem numa corrida. Job ATIVO (o worker já está mandando) não
// sai da fila: aí recusa. Se mesmo assim sobrar um job (re-enfileirado ao
// retomar), o worker pula "recipient row not found". O trigger
// broadcast_recipients_aggregate só mexe nos contadores de status (pending
// não conta em nenhum) — total_recipients é ajustado aqui, na mesma transação.
// Quem chama registra a auditoria (logBroadcastEvent 'remove_recipient').
// ============================================================

import { and, eq, sql } from 'drizzle-orm'

import { db, broadcasts, broadcastRecipients } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadDefaultChannel } from '@/lib/channels/channels'
import { outboundQueue, removeRecipientJobs } from '@/lib/queue/queues'
import { finalizeBroadcastIfDone } from '@/lib/queue/broadcast-jobs'

export type RemoveRecipientResult = { ok: true } | { ok: false; error: string }

/** Estados do disparo em que ainda há fila pra mexer. */
const REMOVABLE_BROADCAST_STATUSES = new Set(['paused', 'scheduled', 'sending'])

const SENDING_NOW = 'Este envio já está saindo agora.'
const ALREADY_SENT = 'Este destinatário já foi enviado.'

async function jobIsActive(channelId: string, recipientId: string): Promise<boolean> {
  const job = await outboundQueue(channelId).getJob(recipientId)
  if (!job) return false
  return (await job.getState()) === 'active'
}

export async function removePendingRecipient(
  accountId: string,
  broadcastId: string,
  recipientId: string,
): Promise<RemoveRecipientResult> {
  try {
    if (!accountId || !broadcastId || !recipientId) {
      return { ok: false, error: 'Destinatário não encontrado neste disparo.' }
    }
    const broadcast = firstOrNull(
      await db
        .select({ status: broadcasts.status, channelId: broadcasts.channelId })
        .from(broadcasts)
        .where(and(eq(broadcasts.id, broadcastId), eq(broadcasts.accountId, accountId)))
        .limit(1),
    )
    if (!broadcast) return { ok: false, error: 'Disparo não encontrado.' }
    if (!REMOVABLE_BROADCAST_STATUSES.has(broadcast.status)) {
      return {
        ok: false,
        error: 'Só dá pra tirar alguém de um disparo agendado, pausado ou em andamento.',
      }
    }

    const recipient = firstOrNull(
      await db
        .select({ status: broadcastRecipients.status })
        .from(broadcastRecipients)
        .where(
          and(
            eq(broadcastRecipients.id, recipientId),
            eq(broadcastRecipients.broadcastId, broadcastId),
          ),
        )
        .limit(1),
    )
    if (!recipient) return { ok: false, error: 'Destinatário não encontrado neste disparo.' }
    if (recipient.status === 'failed') {
      return { ok: false, error: 'O envio para essa pessoa já falhou — não está mais na fila.' }
    }
    if (recipient.status !== 'pending') return { ok: false, error: ALREADY_SENT }

    // Fila do canal que o worker usa: o do disparo, ou o padrão da conta
    // (disparo antigo sem canal gravado — mesmo fallback do worker).
    const channelId =
      broadcast.channelId ?? (await loadDefaultChannel(accountId))?.id ?? null
    if (channelId) {
      if (await jobIsActive(channelId, recipientId)) return { ok: false, error: SENDING_NOW }
      await removeRecipientJobs(channelId, [recipientId])
      // removeRecipientJobs engole o "job travado": se ele virou ativo no meio
      // do caminho, ainda está lá — confere de novo antes de apagar a linha.
      if (await jobIsActive(channelId, recipientId)) return { ok: false, error: SENDING_NOW }
    }

    const removed = await db.transaction(async (tx) => {
      const deleted = await tx
        .delete(broadcastRecipients)
        .where(
          and(
            eq(broadcastRecipients.id, recipientId),
            eq(broadcastRecipients.broadcastId, broadcastId),
            eq(broadcastRecipients.status, 'pending'),
          ),
        )
        .returning({ id: broadcastRecipients.id })
      if (deleted.length === 0) return false
      await tx
        .update(broadcasts)
        .set({
          totalRecipients: sql`GREATEST(COALESCE(${broadcasts.totalRecipients}, 0) - 1, 0)`,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(broadcasts.id, broadcastId))
      return true
    })
    if (!removed) return { ok: false, error: ALREADY_SENT }

    // Era o último pendente de um disparo em andamento → fecha como enviado.
    try {
      await finalizeBroadcastIfDone(broadcastId)
    } catch (finErr) {
      console.error('[broadcast-remove-recipient] finalizar disparo falhou', { broadcastId }, finErr)
    }
    return { ok: true }
  } catch (err) {
    console.error(
      '[broadcast-remove-recipient] falhou',
      { accountId, broadcastId, recipientId },
      err,
    )
    return { ok: false, error: 'Não foi possível tirar essa pessoa do disparo. Tente de novo.' }
  }
}
