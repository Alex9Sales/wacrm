'use server'

// ============================================================
// Server actions da automação comentário→DM do Instagram (por canal).
// Tudo escopado na conta (getCurrentAccount) + o canal tem que ser da conta
// E provider='instagram'. Escritas exigem admin.
// ============================================================

import { and, asc, desc, eq, sql } from 'drizzle-orm'

import { db, channels, instagramCommentAutomations, instagramStorySettings, flows } from '@/db'
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
  /** Variantes da resposta pública (até 3, alternadas). null = usa public_reply. */
  public_replies: string[] | null
  dm_message: string
  once_per_user: boolean
  media_id: string | null
  media_ids: string[] | null
  dm_button_text: string | null
  dm_button_url: string | null
  dm_buttons: { text: string; url: string }[] | null
  /** Depois do DM, inicia este Fluxo pro contato (null = só o DM). */
  start_flow_id: string | null
  /** 🔒 Follow gate: exige seguir o perfil antes de receber o DM com o link. */
  follow_gate: boolean
  follow_gate_message: string | null
  /** ⏰ Cutucada pós-DM pra quem respondeu e sumiu (janela de 24h). */
  follow_up_enabled: boolean
  follow_up_hours: number
  follow_up_message: string | null
  /** 🎯 Qualificação por IA: só manda o DM pra quem bate com o cliente ideal. */
  qualification_enabled: boolean
  qualification_prompt: string | null
  created_at: string
}

export interface CommentAutomationInput {
  channelId: string
  name: string
  enabled: boolean
  matchAny: boolean
  keywords: string
  /** Até 3 variantes de resposta pública — alternamos entre elas a cada envio. */
  publicReplies: string[]
  dmMessage: string
  oncePerUser: boolean
  /** Posts (media_id do IG) que a regra cobre. Vazio = qualquer post. */
  mediaIds: string[]
  /** Botões (estilo ManyChat) no DM: até 3 { text, url }. Vazio = DM só texto. */
  dmButtons: { text: string; url: string }[]
  /** Fluxo a iniciar depois do DM (null = só o DM). */
  startFlowId: string | null
  /** 🔒 Follow gate: exige seguir o perfil antes de receber o DM com o link. */
  followGate: boolean
  /** Mensagem que pede o follow (null = texto padrão). */
  followGateMessage: string | null
  /** ⏰ Cutucada pós-DM pra quem respondeu e sumiu (janela de 24h). */
  followUpEnabled: boolean
  followUpHours: number
  followUpMessage: string | null
  /** 🎯 Qualificação por IA: só manda o DM pra quem bate com o cliente ideal. */
  qualificationEnabled: boolean
  qualificationPrompt: string | null
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
  public_replies: instagramCommentAutomations.publicReplies,
  dm_message: instagramCommentAutomations.dmMessage,
  once_per_user: instagramCommentAutomations.oncePerUser,
  media_id: instagramCommentAutomations.mediaId,
  media_ids: instagramCommentAutomations.mediaIds,
  dm_button_text: instagramCommentAutomations.dmButtonText,
  dm_button_url: instagramCommentAutomations.dmButtonUrl,
  dm_buttons: instagramCommentAutomations.dmButtons,
  start_flow_id: instagramCommentAutomations.startFlowId,
  follow_gate: instagramCommentAutomations.followGate,
  follow_gate_message: instagramCommentAutomations.followGateMessage,
  follow_up_enabled: instagramCommentAutomations.followUpEnabled,
  follow_up_hours: instagramCommentAutomations.followUpHours,
  follow_up_message: instagramCommentAutomations.followUpMessage,
  qualification_enabled: instagramCommentAutomations.qualificationEnabled,
  qualification_prompt: instagramCommentAutomations.qualificationPrompt,
  created_at: instagramCommentAutomations.createdAt,
}


// ------------------------------------------------------------
// 📸 Stories (social selling): auto-DM pra quem responde/menciona story.
// Config por canal (1 linha), separada das regras de comentário.
// ------------------------------------------------------------
export interface StorySettings {
  replyEnabled: boolean
  replyMessage: string
  mentionEnabled: boolean
  mentionMessage: string
}

export async function getStorySettings(channelId: string): Promise<StorySettings> {
  const ctx = await getCurrentAccount()
  await assertIgChannel(ctx.accountId, channelId)
  const row = firstOrNull(
    await db
      .select()
      .from(instagramStorySettings)
      .where(eq(instagramStorySettings.channelId, channelId))
      .limit(1),
  )
  return {
    replyEnabled: row?.replyEnabled ?? false,
    replyMessage: row?.replyMessage ?? '',
    mentionEnabled: row?.mentionEnabled ?? false,
    mentionMessage: row?.mentionMessage ?? '',
  }
}

export async function saveStorySettings(
  channelId: string,
  input: StorySettings,
): Promise<void> {
  const ctx = await requireRole('admin')
  await assertIgChannel(ctx.accountId, channelId)
  await db
    .insert(instagramStorySettings)
    .values({
      channelId,
      accountId: ctx.accountId,
      replyEnabled: input.replyEnabled,
      replyMessage: input.replyMessage.trim() || null,
      mentionEnabled: input.mentionEnabled,
      mentionMessage: input.mentionMessage.trim() || null,
    })
    .onConflictDoUpdate({
      target: instagramStorySettings.channelId,
      set: {
        replyEnabled: input.replyEnabled,
        replyMessage: input.replyMessage.trim() || null,
        mentionEnabled: input.mentionEnabled,
        mentionMessage: input.mentionMessage.trim() || null,
        updatedAt: new Date().toISOString(),
      },
    })
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
  if (!input.dmMessage.trim()) throw new Error('Escreva a mensagem do DM.')
  if (!input.matchAny && !input.keywords.trim()) {
    throw new Error('Informe ao menos uma palavra-chave (ou marque "qualquer comentário").')
  }
}

/** Normaliza os botões do DM: apara, tira vazios, corta em 3. Devolve as colunas
 *  (lista nova `dmButtons` + par legado com o 1º botão, pra compat de leitura). */
function buttonCols(input: CommentAutomationInput) {
  const buttons = (input.dmButtons ?? [])
    .map((b) => ({ text: b.text.trim(), url: b.url.trim() }))
    .filter((b) => b.text && b.url)
    .slice(0, 3)
  return {
    dmButtons: buttons.length ? buttons : null,
    dmButtonText: buttons[0]?.text ?? null,
    dmButtonUrl: buttons[0]?.url ?? null,
  }
}

/** Nome padrão quando vem vazio (o nome é opcional pro usuário). */
function fallbackName(input: CommentAutomationInput): string {
  if (input.matchAny) return 'Qualquer comentário'
  const first = input.keywords
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)[0]
  return first ? `Palavra "${first}"` : 'Automação de comentário'
}

/** Cria uma regra. */
/** Variantes da resposta pública: até 3, sem vazias; a 1ª também vai no campo
 *  legado `public_reply` (compat de leitura em código antigo). */
function publicReplyCols(input: CommentAutomationInput) {
  const replies = (input.publicReplies ?? [])
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .slice(0, 3)
  return {
    publicReply: replies[0] ?? null,
    publicReplies: replies.length ? replies : null,
  }
}

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
        name: input.name.trim() || fallbackName(input),
        enabled: input.enabled,
        matchAny: input.matchAny,
        keywords: input.keywords.trim(),
        ...publicReplyCols(input),
        dmMessage: input.dmMessage.trim(),
        oncePerUser: input.oncePerUser,
        mediaIds: input.mediaIds.length ? input.mediaIds : null,
        mediaId: null,
        ...buttonCols(input),
        startFlowId: input.startFlowId || null,
        followGate: input.followGate,
        followGateMessage: input.followGateMessage?.trim() || null,
        followUpEnabled: input.followUpEnabled,
        followUpHours: Math.min(20, Math.max(1, Math.round(input.followUpHours || 4))),
        followUpMessage: input.followUpMessage?.trim() || null,
        qualificationEnabled: input.qualificationEnabled,
        qualificationPrompt: input.qualificationPrompt?.trim() || null,
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
      name: input.name.trim() || fallbackName(input),
      enabled: input.enabled,
      matchAny: input.matchAny,
      keywords: input.keywords.trim(),
      ...publicReplyCols(input),
      dmMessage: input.dmMessage.trim(),
      oncePerUser: input.oncePerUser,
      mediaIds: input.mediaIds.length ? input.mediaIds : null,
      mediaId: null,
      ...buttonCols(input),
      startFlowId: input.startFlowId || null,
      followGate: input.followGate,
      followGateMessage: input.followGateMessage?.trim() || null,
      followUpEnabled: input.followUpEnabled,
      followUpHours: Math.min(20, Math.max(1, Math.round(input.followUpHours || 4))),
      followUpMessage: input.followUpMessage?.trim() || null,
      qualificationEnabled: input.qualificationEnabled,
      qualificationPrompt: input.qualificationPrompt?.trim() || null,
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

export interface FlowLite {
  id: string
  name: string
  /** A entrada do fluxo é um nó de BOTÕES? Comentário→fluxo exige isso (senão a
   *  2ª msg trava na janela de 24h do IG — a pessoa precisa tocar num botão). */
  entry_is_buttons: boolean
}

/** Fluxos ATIVOS da conta — pro seletor "iniciar fluxo depois do DM". */
export async function listActiveFlows(): Promise<FlowLite[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: flows.id,
      name: flows.name,
      entry_is_buttons: sql<boolean>`EXISTS (SELECT 1 FROM flow_nodes n WHERE n.flow_id = ${flows.id} AND n.node_key = ${flows.entryNodeId} AND n.node_type = 'send_buttons')`,
    })
    .from(flows)
    .where(and(eq(flows.accountId, ctx.accountId), eq(flows.status, 'active')))
    .orderBy(asc(flows.name))
  return rows
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
