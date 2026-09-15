// ============================================================
// Trava do servidor: disparo pelo número dedicado a OUTRA pessoa só com
// confirmação explícita de quem cria.
//
// 15/09 (GoLink): o "dia do cliente" do Vitor saiu pelo número do Leonardo
// sem ninguém perceber — as conversas nasceram lá e ele não via nenhuma. A
// tela avisa e pede confirmação (channel-choice.ts); isto garante o mesmo nas
// ações do servidor (Disparo de texto e Disparo pela etapa do funil).
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, channels, user } from '@/db'
import { firstOrNull } from '@/db/helpers'

/** Mensagem de erro quando precisa confirmar; null = pode seguir. */
export async function otherPersonNumberError(
  accountId: string,
  userId: string,
  channelId: string,
  confirmed: boolean | undefined,
): Promise<string | null> {
  if (confirmed || !channelId) return null
  const row = firstOrNull(
    await db
      .select({ dedicatedUserId: channels.dedicatedUserId, ownerName: user.name })
      .from(channels)
      .leftJoin(user, eq(user.id, channels.dedicatedUserId))
      .where(and(eq(channels.id, channelId), eq(channels.accountId, accountId)))
      .limit(1),
  )
  if (!row?.dedicatedUserId || row.dedicatedUserId === userId) return null
  const owner = row.ownerName?.trim() || 'outra pessoa'
  return `Este canal é o número de ${owner}: as mensagens saem pelo WhatsApp dessa pessoa e as respostas chegam pra ela. Escolha o seu número ou confirme que quer usar esse.`
}
