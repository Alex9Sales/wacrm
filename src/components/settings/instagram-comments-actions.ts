'use server'

// ============================================================
// Server actions da automação comentário→DM do Instagram (por canal).
// Tudo escopado na conta (getCurrentAccount) + o canal tem que ser da conta
// E provider='instagram'. Escritas exigem admin.
// ============================================================

import { and, asc, desc, eq } from 'drizzle-orm'

import { db, channels, instagramCommentAutomations } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { loadChannelByAccount } from '@/lib/channels/channels'
import { fetchInstagramMedia } from '@/lib/channels/providers/instagram'

export interface CommentAutomation {
  id: string
  channel_id: string
  name: string
  enabled: boolean
  match_any: boolean
  keywords: string
  public_reply: string | null
  dm_message: string
  once_per_user: boolean
  media_id: string | null
  created_at: string
}

export interface CommentAutomationInput {
  channelId: string
  name: string
  enabled: boolean
  matchAny: boolean
  keywords: string
  publicReply: string | null
  dmMessage: string
  oncePerUser: boolean
  /** Post específico (media_id do IG) OU null = qualquer post. */
  mediaId: string | null
}

/** Garante que o canal é da conta e é Instagram. Lança se não for. */
async function assertIgChannel(accountId: string, channelId: string): Promise<void> {
  const ch = firstOrNull(
    await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.accountId, accountId),
          eq(channels.provider, 'instagram'),
        ),
      )
      .limit(1),
  )
  if (!ch) throw new Error('Canal Instagram não encontrado.')
}

const cols = {
  id: instagramCommentAutomations.id,
  channel_id: instagramCommentAutomations.channelId,
  name: instagramCommentAutomations.name,
  enabled: instagramCommentAutomations.enabled,
  match_any: instagramCommentAutomations.matchAny,
  keywords: instagramCommentAutomations.keywords,
  public_reply: instagramCommentAutomations.publicReply,
  dm_message: instagramCommentAutomations.dmMessage,
  once_per_user: instagramCommentAutomations.oncePerUser,
  media_id: instagramCommentAutomations.mediaId,
  created_at: instagramCommentAutomations.createdAt,
}

/** Lista as regras de um canal Instagram (mais novas primeiro). */
export async function listCommentAutomations(
  channelId: string,
): Promise<CommentAutomation[]> {
  const ctx = await getCurrentAccount()
  await assertIgChannel(ctx.accountId, channelId)
  const rows = await db
    .select(cols)
    .from(instagramCommentAutomations)
    .where(
      and(
        eq(instagramCommentAutomations.accountId, ctx.accountId),
        eq(instagramCommentAutomations.channelId, channelId),
      ),
    )
    .orderBy(desc(instagramCommentAutomations.createdAt))
  return rows as unknown as CommentAutomation[]
}

function validate(input: CommentAutomationInput): void {
  if (!input.name.trim()) throw new Error('Dê um nome à automação.')
  if (!input.dmMessage.trim()) throw new Error('Escreva a mensagem do DM.')
  if (!input.matchAny && !input.keywords.trim()) {
    throw new Error('Informe ao menos uma palavra-chave (ou marque "qualquer comentário").')
  }
}

/** Cria uma regra. */
export async function createCommentAutomation(
  input: CommentAutomationInput,
): Promise<CommentAutomation> {
  const ctx = await requireRole('admin')
  await assertIgChannel(ctx.accountId, input.channelId)
  validate(input)
  const row = firstOrNull(
    await db
      .insert(instagramCommentAutomations)
      .values({
        accountId: ctx.accountId,
        channelId: input.channelId,
        name: input.name.trim(),
        enabled: input.enabled,
        matchAny: input.matchAny,
        keywords: input.keywords.trim(),
        publicReply: input.publicReply?.trim() || null,
        dmMessage: input.dmMessage.trim(),
        oncePerUser: input.oncePerUser,
        mediaId: input.mediaId?.trim() || null,
      })
      .returning(cols),
  )
  if (!row) throw new Error('Falha ao criar a automação.')
  return row as unknown as CommentAutomation
}

/** Atualiza uma regra (escopada na conta). */
export async function updateCommentAutomation(
  id: string,
  input: CommentAutomationInput,
): Promise<void> {
  const ctx = await requireRole('admin')
  await assertIgChannel(ctx.accountId, input.channelId)
  validate(input)
  await db
    .update(instagramCommentAutomations)
    .set({
      name: input.name.trim(),
      enabled: input.enabled,
      matchAny: input.matchAny,
      keywords: input.keywords.trim(),
      publicReply: input.publicReply?.trim() || null,
      dmMessage: input.dmMessage.trim(),
      oncePerUser: input.oncePerUser,
      mediaId: input.mediaId?.trim() || null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(instagramCommentAutomations.id, id),
        eq(instagramCommentAutomations.accountId, ctx.accountId),
      ),
    )
}

/** Liga/desliga uma regra sem abrir o editor. */
export async function toggleCommentAutomation(
  id: string,
  enabled: boolean,
): Promise<void> {
  const ctx = await requireRole('admin')
  await db
    .update(instagramCommentAutomations)
    .set({ enabled, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(instagramCommentAutomations.id, id),
        eq(instagramCommentAutomations.accountId, ctx.accountId),
      ),
    )
}

/** Remove uma regra. */
export async function deleteCommentAutomation(id: string): Promise<void> {
  const ctx = await requireRole('admin')
  await db
    .delete(instagramCommentAutomations)
    .where(
      and(
        eq(instagramCommentAutomations.id, id),
        eq(instagramCommentAutomations.accountId, ctx.accountId),
      ),
    )
}

export interface CommentPost {
  id: string
  caption: string | null
  thumbnail_url: string | null
  permalink: string | null
}

/** Posts recentes da conta IG do canal (pro seletor de post da automação). */
export async function listInstagramPosts(
  channelId: string,
): Promise<CommentPost[]> {
  const ctx = await getCurrentAccount()
  await assertIgChannel(ctx.accountId, channelId)
  // ⚠️ ordem: loadChannelByAccount(accountId, channelId) — NÃO inverter.
  const ch = await loadChannelByAccount(ctx.accountId, channelId)
  if (!ch) return []
  const media = await fetchInstagramMedia(ch, 30)
  return media.map((m) => ({
    id: m.id,
    caption: m.caption,
    thumbnail_url: m.thumbnailUrl,
    permalink: m.permalink,
  }))
}

export interface IgChannelLite {
  id: string
  name: string
}

/** Canais Instagram da conta (pro seletor de canal na página de Automações). */
export async function listInstagramChannels(): Promise<IgChannelLite[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({ id: channels.id, name: channels.name })
    .from(channels)
    .where(
      and(
        eq(channels.accountId, ctx.accountId),
        eq(channels.provider, 'instagram'),
      ),
    )
    .orderBy(asc(channels.createdAt))
  return rows
}
