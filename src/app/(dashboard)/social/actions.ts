'use server'

// ============================================================
// Publicações no Instagram (tela /social). Escopo por conta em toda query;
// criar/agendar/cancelar exige supervisor+ (mesmo nível de quem gerencia
// automações). O envio de verdade é do worker (lib/social/instagram-publish).
//
// Erros ESPERADOS voltam como { ok:false, error } — em produção um `throw`
// dentro de Server Action chega sanitizado ("digest") no navegador.
// ============================================================

import { and, desc, eq, inArray } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { db, channels, socialPosts } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import {
  validatePost,
  type SocialAutomationDraft,
  type SocialMediaItem,
  type SocialPostKind,
  type SocialPostStatus,
} from '@/lib/social/social-shared'
import {
  listActiveFlows,
  listInstagramChannels,
  type FlowLite,
  type IgChannelLite,
} from '@/components/settings/instagram-comments-actions'

export interface SocialPostRow {
  id: string
  channelId: string
  channelName: string
  kind: SocialPostKind
  caption: string
  media: SocialMediaItem[]
  shareToFeed: boolean
  status: SocialPostStatus
  scheduledAt: string | null
  publishedAt: string | null
  igMediaId: string | null
  permalink: string | null
  error: string | null
  automationId: string | null
  automation: SocialAutomationDraft | null
  attempts: number
  createdAt: string
  updatedAt: string
}

export interface SocialPostInput {
  id?: string
  channelId: string
  kind: SocialPostKind
  caption: string
  media: SocialMediaItem[]
  shareToFeed: boolean
  coverUrl?: string | null
  automation: SocialAutomationDraft | null
}

export type SocialSubmit = { when: 'draft' } | { when: 'now' } | { when: 'at'; at: string }
export type ActionResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string }

const KINDS: SocialPostKind[] = ['image', 'carousel', 'reel', 'story']

async function findIgChannel(accountId: string, channelId: string): Promise<{ id: string; name: string } | null> {
  return firstOrNull(
    await db
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.accountId, accountId), eq(channels.provider, 'instagram')))
      .limit(1),
  )
}

function cleanMedia(media: unknown): SocialMediaItem[] {
  if (!Array.isArray(media)) return []
  return media
    .filter(
      (m): m is SocialMediaItem =>
        !!m && typeof m.url === 'string' && /^https?:\/\//.test(m.url) && (m.type === 'image' || m.type === 'video'),
    )
    .map((m) => ({ url: m.url, type: m.type, ...(m.name ? { name: String(m.name).slice(0, 200) } : {}) }))
    .slice(0, 10)
}

function cleanAutomation(a: unknown): SocialAutomationDraft | null {
  if (!a || typeof a !== 'object') return null
  const d = a as Partial<SocialAutomationDraft>
  const dmMessage = typeof d.dmMessage === 'string' ? d.dmMessage.trim() : ''
  if (!dmMessage) return null
  return {
    keywords: typeof d.keywords === 'string' ? d.keywords.trim().slice(0, 500) : '',
    matchAny: Boolean(d.matchAny),
    publicReplies: (Array.isArray(d.publicReplies) ? d.publicReplies : [])
      .map((s) => (typeof s === 'string' ? s.trim().slice(0, 500) : ''))
      .filter(Boolean)
      .slice(0, 3),
    dmMessage: dmMessage.slice(0, 1000),
    dmButtons: (Array.isArray(d.dmButtons) ? d.dmButtons : [])
      .filter(
        (b) =>
          b && typeof b.text === 'string' && typeof b.url === 'string' && b.text.trim() && /^https?:\/\//.test(b.url.trim()),
      )
      .map((b) => ({ text: b.text.trim().slice(0, 40), url: b.url.trim().slice(0, 500) }))
      .slice(0, 3),
    oncePerUser: d.oncePerUser !== false,
    startFlowId: typeof d.startFlowId === 'string' && d.startFlowId ? d.startFlowId : null,
  }
}

function toRow(r: typeof socialPosts.$inferSelect, channelName: string): SocialPostRow {
  return {
    id: r.id,
    channelId: r.channelId,
    channelName,
    kind: r.kind as SocialPostKind,
    caption: r.caption,
    media: (r.media ?? []) as SocialMediaItem[],
    shareToFeed: r.shareToFeed,
    status: r.status as SocialPostStatus,
    scheduledAt: r.scheduledAt,
    publishedAt: r.publishedAt,
    igMediaId: r.igMediaId,
    permalink: r.permalink,
    error: r.error,
    automationId: r.automationId,
    automation: (r.automationDraft as SocialAutomationDraft | null) ?? null,
    attempts: r.attempts,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

/** Lista as publicações da conta (mais recentes primeiro). */
export async function listSocialPosts(): Promise<SocialPostRow[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select()
    .from(socialPosts)
    .where(eq(socialPosts.accountId, ctx.accountId))
    .orderBy(desc(socialPosts.createdAt))
    .limit(200)
  const chIds = Array.from(new Set(rows.map((r) => r.channelId)))
  const names = new Map<string, string>()
  if (chIds.length) {
    const chs = await db
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(inArray(channels.id, chIds))
    for (const c of chs) names.set(c.id, c.name)
  }
  return rows.map((r) => toRow(r, names.get(r.channelId) ?? 'Instagram'))
}

/** Canais IG + fluxos ativos pro compositor. */
export async function getSocialComposerOptions(): Promise<{ channels: IgChannelLite[]; flows: FlowLite[] }> {
  const [chs, flows] = await Promise.all([listInstagramChannels(), listActiveFlows()])
  return { channels: chs, flows }
}

/** Cria/atualiza a publicação e decide o destino: rascunho, agora ou agendada. */
export async function saveSocialPost(
  input: SocialPostInput,
  submit: SocialSubmit,
): Promise<ActionResult<{ id: string; status: SocialPostStatus }>> {
  const ctx = await requireRole('supervisor')
  if (!KINDS.includes(input.kind)) return { ok: false, error: 'Tipo de publicação inválido.' }
  if (!(await findIgChannel(ctx.accountId, input.channelId))) {
    return { ok: false, error: 'Canal do Instagram não encontrado nesta conta.' }
  }
  const media = cleanMedia(input.media)
  const caption = input.kind === 'story' ? '' : String(input.caption ?? '').trim()
  const invalid = validatePost(input.kind, media, caption)
  if (invalid && submit.when !== 'draft') return { ok: false, error: invalid }
  const automation = input.kind === 'story' ? null : cleanAutomation(input.automation)

  let status: SocialPostStatus = 'draft'
  let scheduledAt: string | null = null
  if (submit.when === 'now') {
    status = 'scheduled'
    scheduledAt = new Date().toISOString()
  } else if (submit.when === 'at') {
    const at = new Date(submit.at)
    if (Number.isNaN(at.getTime())) return { ok: false, error: 'Data/hora do agendamento inválida.' }
    if (at.getTime() < Date.now() - 60_000) return { ok: false, error: 'A data do agendamento já passou.' }
    status = 'scheduled'
    scheduledAt = at.toISOString()
  }

  const values = {
    channelId: input.channelId,
    kind: input.kind,
    caption,
    media,
    shareToFeed: input.shareToFeed !== false,
    coverUrl: typeof input.coverUrl === 'string' && /^https?:\/\//.test(input.coverUrl) ? input.coverUrl : null,
    automationDraft: automation as unknown as Record<string, unknown> | null,
    status,
    scheduledAt,
    error: null,
    publishState: null,
    updatedAt: new Date().toISOString(),
  }

  if (input.id) {
    const existing = firstOrNull(
      await db
        .select({ id: socialPosts.id, status: socialPosts.status })
        .from(socialPosts)
        .where(and(eq(socialPosts.id, input.id), eq(socialPosts.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!existing) return { ok: false, error: 'Publicação não encontrada.' }
    if (existing.status === 'publishing' || existing.status === 'published') {
      return { ok: false, error: 'Essa publicação já foi (ou está sendo) publicada — não dá mais pra editar.' }
    }
    await db.update(socialPosts).set(values).where(eq(socialPosts.id, input.id))
    revalidatePath('/social')
    return { ok: true, id: input.id, status }
  }

  const row = firstOrNull(
    await db
      .insert(socialPosts)
      .values({ accountId: ctx.accountId, createdBy: ctx.userId, ...values })
      .returning({ id: socialPosts.id }),
  )
  if (!row) return { ok: false, error: 'Não foi possível salvar a publicação.' }
  revalidatePath('/social')
  return { ok: true, id: row.id, status }
}

/** Agendada → volta pra rascunho (não perde o conteúdo). */
export async function cancelSocialPost(id: string): Promise<ActionResult> {
  const ctx = await requireRole('supervisor')
  await db
    .update(socialPosts)
    .set({ status: 'draft', scheduledAt: null, updatedAt: new Date().toISOString() })
    .where(and(eq(socialPosts.id, id), eq(socialPosts.accountId, ctx.accountId), eq(socialPosts.status, 'scheduled')))
  revalidatePath('/social')
  return { ok: true }
}

/** Falhou → tenta de novo agora (estado do publicador zerado). */
export async function retrySocialPost(id: string): Promise<ActionResult> {
  const ctx = await requireRole('supervisor')
  await db
    .update(socialPosts)
    .set({
      status: 'scheduled',
      scheduledAt: new Date().toISOString(),
      error: null,
      publishState: null,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(socialPosts.id, id), eq(socialPosts.accountId, ctx.accountId), eq(socialPosts.status, 'failed')))
  revalidatePath('/social')
  return { ok: true }
}

/** Apaga o registro (não apaga do Instagram). Em publicação não dá. */
export async function deleteSocialPost(id: string): Promise<ActionResult> {
  const ctx = await requireRole('supervisor')
  const existing = firstOrNull(
    await db
      .select({ status: socialPosts.status })
      .from(socialPosts)
      .where(and(eq(socialPosts.id, id), eq(socialPosts.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!existing) return { ok: true }
  if (existing.status === 'publishing') return { ok: false, error: 'Espere terminar de publicar antes de excluir.' }
  await db.delete(socialPosts).where(and(eq(socialPosts.id, id), eq(socialPosts.accountId, ctx.accountId)))
  revalidatePath('/social')
  return { ok: true }
}
