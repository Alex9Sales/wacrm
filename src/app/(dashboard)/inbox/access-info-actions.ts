'use server'

// ============================================================
// Por que um link /inbox?c=<id> não abriu — "sem acesso" × "não existe".
//
// 15/09 (GoLink, Vitor): o "Chat" do disparo abria a caixa com "está com
// outra pessoa (sem acesso) ou foi apagada". Era a primeira: a conversa
// estava no número Atendimento, dedicado ao Leonardo. A página só chama isto
// DEPOIS que getConversationWithContact devolveu null, e a resposta diz só o
// necessário pra pedir acesso (número + com quem está), nunca o conteúdo.
// ============================================================

import { and, eq } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { db, channels, conversations, user } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import { canReadConversation, isAdminUser } from '@/lib/sectors/access'
import type { ConversationAccessInfo } from '@/lib/inbox/access-notice'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const channelOwner = alias(user, 'access_channel_owner')
const assignee = alias(user, 'access_assignee')

export async function conversationAccessInfo(
  conversationId: string,
): Promise<ConversationAccessInfo> {
  // Link colado errado nem chega no banco (uuid inválido quebraria a query).
  if (!UUID_RE.test(conversationId ?? '')) return { status: 'not_found' }
  const ctx = await getCurrentAccount()

  const row = firstOrNull(
    await db
      .select({
        sectorId: conversations.sectorId,
        assignedAgentId: conversations.assignedAgentId,
        isPrivate: conversations.isPrivate,
        channelName: channels.name,
        channelOwnerId: channels.dedicatedUserId,
        channelOwnerName: channelOwner.name,
        assigneeName: assignee.name,
      })
      .from(conversations)
      .leftJoin(channels, eq(channels.id, conversations.channelId))
      .leftJoin(channelOwner, eq(channelOwner.id, channels.dedicatedUserId))
      .leftJoin(assignee, eq(assignee.id, conversations.assignedAgentId))
      .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!row) return { status: 'not_found' }

  const readable = await canReadConversation(
    ctx.role,
    ctx.userId,
    ctx.accountId,
    row.sectorId,
    row.assignedAgentId,
    conversationId,
    row.isPrivate,
  )
  if (readable) return { status: 'ok' }

  // Com quem está: o dono do número dedicado; senão quem atende. Conversa
  // atribuída a admin/dono não diz o nome ("ninguém vê as do admin").
  let holderName: string | null = row.channelOwnerId ? row.channelOwnerName ?? null : null
  if (!holderName && row.assignedAgentId && row.assigneeName) {
    const assignedToAdmin = await isAdminUser(ctx.accountId, row.assignedAgentId)
    holderName = assignedToAdmin ? null : row.assigneeName
  }
  return { status: 'no_access', channelName: row.channelName ?? null, holderName }
}
