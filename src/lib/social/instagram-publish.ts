// ============================================================
// 📸 Publicador do Instagram (Graph API content publishing) — worker-reachable
// (SEM 'server-only'). Máquina de estados persistida em social_posts.publish_state:
//
//   scheduled ──(tick)──▶ publishing/containers ─▶ [parent] ─▶ publish ─▶ published
//                                                                 └─▶ failed
//
//   • image  : POST /{ig}/media {image_url, caption}                → container
//   • story  : POST /{ig}/media {media_type: STORIES, image|video}  → container
//   • reel   : POST /{ig}/media {media_type: REELS, video_url, …}   → container (processa)
//   • carousel: 1 container por item (is_carousel_item) → quando TODOS prontos,
//               container CAROUSEL {children, caption} → container
//   depois: GET /{container}?fields=status_code até FINISHED → POST /{ig}/media_publish.
//
// Vídeo demora (30s–min): o tick não bloqueia — guarda o container e volta no
// próximo (30s). Timeout 30min → failed. Erro da Graph com código → failed na
// hora; rede/5xx/rate-limit → tenta de novo no próximo tick.
//
// Ao publicar (não-story) com `automation_draft`: cria a regra comentário→DM
// amarrada ao media_id (mesmas colunas do editor de Automações).
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, instagramCommentAutomations, socialPosts } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadChannel } from '@/lib/channels/channels'
import type { ChannelCtx } from '@/lib/channels/provider'

import {
  graphErrorMessage,
  isTransientGraph,
  planContainers,
  validatePost,
  type PublishState,
  type SocialAutomationDraft,
  type SocialMediaItem,
  type SocialPostKind,
} from './social-shared'

export * from './social-shared'

const PROCESSING_TIMEOUT_MS = 30 * 60_000
const DEFAULT_GRAPH_BASE = 'https://graph.facebook.com/v21.0'

// ---------------------------------------------------------------- Graph

export class GraphError extends Error {
  transient: boolean
  constructor(message: string, transient: boolean) {
    super(message)
    this.transient = transient
  }
}

function tokenOf(ch: ChannelCtx): string {
  const token = ch.credentials.accessToken
  if (typeof token !== 'string' || !token) throw new GraphError('Canal do Instagram sem token de acesso. Reconecte o canal.', false)
  return token
}
function igIdOf(ch: ChannelCtx): string {
  const id = ch.providerMeta.ig_id
  if (typeof id !== 'string' || !id) throw new GraphError('Canal do Instagram sem ig_id. Reconecte o canal.', false)
  return id
}
function graphBaseOf(ch: ChannelCtx): string {
  const base = ch.providerMeta.graphBase
  return typeof base === 'string' && base ? base.replace(/\/+$/, '') : DEFAULT_GRAPH_BASE
}

async function graphCall(
  ch: ChannelCtx,
  method: 'GET' | 'POST',
  path: string,
  params?: Record<string, string | boolean | number>,
): Promise<Record<string, unknown>> {
  const url = `${graphBaseOf(ch)}/${path}`
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${tokenOf(ch)}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: method === 'POST' ? JSON.stringify(params ?? {}) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    throw new GraphError(`Sem resposta do Instagram (${err instanceof Error ? err.message : 'rede'}).`, true)
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new GraphError(graphErrorMessage(body, res.status), isTransientGraph(res.status, body))
  return body
}

async function createContainer(ch: ChannelCtx, params: Record<string, string | boolean>): Promise<string> {
  const body = await graphCall(ch, 'POST', `${igIdOf(ch)}/media`, params)
  const id = body.id
  if (typeof id !== 'string' || !id) throw new GraphError('Instagram não devolveu o id do container.', true)
  return id
}

type ContainerStatus = 'FINISHED' | 'IN_PROGRESS' | 'ERROR' | 'EXPIRED' | 'PUBLISHED' | 'UNKNOWN'
async function containerStatus(ch: ChannelCtx, containerId: string): Promise<{ code: ContainerStatus; detail: string }> {
  const body = await graphCall(ch, 'GET', `${containerId}?fields=status_code,status`)
  const code = String(body.status_code ?? 'UNKNOWN') as ContainerStatus
  const detail = typeof body.status === 'string' ? body.status : ''
  return { code, detail }
}

async function publishContainer(ch: ChannelCtx, containerId: string): Promise<string> {
  const body = await graphCall(ch, 'POST', `${igIdOf(ch)}/media_publish`, { creation_id: containerId })
  const id = body.id
  if (typeof id !== 'string' || !id) throw new GraphError('Instagram não devolveu o id da publicação.', true)
  return id
}

async function fetchPermalink(ch: ChannelCtx, mediaId: string): Promise<string | null> {
  try {
    const body = await graphCall(ch, 'GET', `${mediaId}?fields=permalink`)
    return typeof body.permalink === 'string' ? body.permalink : null
  } catch {
    return null // story não tem permalink; não é erro
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Espera o container ficar pronto por até `budgetMs` (polls curtos dentro do tick). */
async function waitReady(
  ch: ChannelCtx,
  containerId: string,
  budgetMs: number,
): Promise<{ code: ContainerStatus; detail: string }> {
  const started = Date.now()
  let last = await containerStatus(ch, containerId)
  while (last.code === 'IN_PROGRESS' && Date.now() - started < budgetMs) {
    await sleep(3_000)
    last = await containerStatus(ch, containerId)
  }
  return last
}

// ---------------------------------------------------------------- automação comentário→DM

function automationName(draft: SocialAutomationDraft, publishedAt: Date): string {
  const first = draft.keywords
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)[0]
  const day = `${String(publishedAt.getDate()).padStart(2, '0')}/${String(publishedAt.getMonth() + 1).padStart(2, '0')}`
  return first ? `Post ${day} · "${first}"` : `Post ${day} · qualquer comentário`
}

/** Cria a regra comentário→DM pro post publicado (mesmas colunas do editor). */
export async function createAutomationForPost(
  post: { accountId: string; channelId: string; automationDraft: Record<string, unknown> | null },
  mediaId: string,
): Promise<string | null> {
  const d = post.automationDraft as SocialAutomationDraft | null
  if (!d || typeof d.dmMessage !== 'string' || !d.dmMessage.trim()) return null
  const replies = (Array.isArray(d.publicReplies) ? d.publicReplies : [])
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .slice(0, 3)
  const buttons = (Array.isArray(d.dmButtons) ? d.dmButtons : [])
    .filter((b) => b && typeof b.text === 'string' && b.text.trim() && typeof b.url === 'string' && b.url.trim())
    .map((b) => ({ text: b.text.trim(), url: b.url.trim() }))
    .slice(0, 3)
  const keywords = typeof d.keywords === 'string' ? d.keywords.trim() : ''
  const row = firstOrNull(
    await db
      .insert(instagramCommentAutomations)
      .values({
        accountId: post.accountId,
        channelId: post.channelId,
        name: automationName({ ...d, keywords }, new Date()),
        enabled: true,
        matchAny: Boolean(d.matchAny) || !keywords,
        keywords,
        publicReply: replies[0] ?? null,
        publicReplies: replies.length ? replies : null,
        dmMessage: d.dmMessage.trim(),
        oncePerUser: d.oncePerUser !== false,
        mediaIds: [mediaId],
        mediaId: null,
        dmButtonText: buttons[0]?.text ?? null,
        dmButtonUrl: buttons[0]?.url ?? null,
        dmButtons: buttons.length ? buttons : null,
        startFlowId: typeof d.startFlowId === 'string' && d.startFlowId ? d.startFlowId : null,
      })
      .returning({ id: instagramCommentAutomations.id }),
  )
  return row?.id ?? null
}

// ---------------------------------------------------------------- máquina de estados

export type AdvanceResult = 'published' | 'waiting' | 'failed' | 'skipped'

async function saveState(postId: string, state: PublishState, extra: Partial<typeof socialPosts.$inferInsert> = {}) {
  await db
    .update(socialPosts)
    .set({ publishState: state as unknown as Record<string, unknown>, updatedAt: new Date().toISOString(), ...extra })
    .where(eq(socialPosts.id, postId))
}

async function markFailed(postId: string, message: string): Promise<AdvanceResult> {
  await db
    .update(socialPosts)
    .set({ status: 'failed', error: message.slice(0, 1000), updatedAt: new Date().toISOString() })
    .where(and(eq(socialPosts.id, postId), eq(socialPosts.status, 'publishing')))
  return 'failed'
}

/**
 * Avança UM post em `publishing`. Idempotente por etapa: cada container criado
 * é gravado antes de seguir, então um tick interrompido não duplica.
 */
export async function advanceSocialPost(postId: string): Promise<AdvanceResult> {
  const post = firstOrNull(await db.select().from(socialPosts).where(eq(socialPosts.id, postId)).limit(1))
  if (!post || post.status !== 'publishing') return 'skipped'
  const kind = post.kind as SocialPostKind
  const media = (post.media ?? []) as SocialMediaItem[]
  const state: PublishState = (post.publishState as PublishState | null) ?? {
    stage: 'containers',
    startedAt: new Date().toISOString(),
  }
  const startedAt = new Date(state.startedAt).getTime() || Date.now()
  const elapsed = Date.now() - startedAt

  const invalid = validatePost(kind, media, post.caption)
  if (invalid) return markFailed(postId, invalid)

  const ch = await loadChannel(post.channelId)
  if (!ch) return markFailed(postId, 'Canal do Instagram não encontrado (foi removido?).')

  const plan = planContainers(kind, media, post.caption, { shareToFeed: post.shareToFeed, coverUrl: post.coverUrl })
  // Orçamento de espera dentro do tick: imagem fica pronta em segundos; vídeo não.
  const hasVideo = media.some((m) => m.type === 'video')
  const budget = hasVideo ? 20_000 : 40_000

  try {
    if (state.stage === 'containers') {
      if (plan.single) {
        const id = await createContainer(ch, plan.single.params)
        state.containerId = id
        state.stage = 'publish'
        await saveState(postId, state)
      } else {
        const childIds = state.childIds ?? []
        for (let i = childIds.length; i < plan.children.length; i++) {
          childIds.push(await createContainer(ch, plan.children[i].params))
          state.childIds = childIds
          await saveState(postId, state) // grava a cada filho: retomada sem duplicar
        }
        state.stage = 'parent'
        await saveState(postId, state)
      }
    }

    if (state.stage === 'parent') {
      // Todos os filhos precisam estar FINISHED antes do container CAROUSEL.
      for (const childId of state.childIds ?? []) {
        const st = await waitReady(ch, childId, budget)
        if (st.code === 'ERROR' || st.code === 'EXPIRED') {
          return markFailed(postId, `Item do carrossel falhou no Instagram: ${st.detail || st.code}`)
        }
        if (st.code !== 'FINISHED') {
          if (elapsed > PROCESSING_TIMEOUT_MS) return markFailed(postId, 'Instagram não terminou de processar a mídia em 30 min.')
          state.polls = (state.polls ?? 0) + 1
          await saveState(postId, state)
          return 'waiting'
        }
      }
      const parentParams = { ...plan.parent!.params, children: (state.childIds ?? []).join(',') }
      state.containerId = await createContainer(ch, parentParams)
      state.stage = 'publish'
      await saveState(postId, state)
    }

    if (state.stage === 'publish') {
      const st = await waitReady(ch, state.containerId!, budget)
      if (st.code === 'ERROR' || st.code === 'EXPIRED') {
        return markFailed(postId, `Instagram recusou a mídia: ${st.detail || st.code}`)
      }
      if (st.code === 'IN_PROGRESS' || st.code === 'UNKNOWN') {
        if (elapsed > PROCESSING_TIMEOUT_MS) return markFailed(postId, 'Instagram não terminou de processar a mídia em 30 min.')
        state.polls = (state.polls ?? 0) + 1
        await saveState(postId, state)
        return 'waiting'
      }
      const mediaId = await publishContainer(ch, state.containerId!)
      const permalink = kind === 'story' ? null : await fetchPermalink(ch, mediaId)
      let automationId: string | null = null
      if (kind !== 'story') {
        try {
          automationId = await createAutomationForPost(post, mediaId)
        } catch (err) {
          console.error('[social] automação pós-publicação falhou:', postId, err instanceof Error ? err.message : err)
        }
      }
      await db
        .update(socialPosts)
        .set({
          status: 'published',
          publishedAt: new Date().toISOString(),
          igMediaId: mediaId,
          permalink,
          automationId,
          error: null,
          publishState: { ...state, stage: 'publish', done: true } as unknown as Record<string, unknown>,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(socialPosts.id, postId))
      return 'published'
    }
    return 'waiting'
  } catch (err) {
    const transient = err instanceof GraphError ? err.transient : true
    const message = err instanceof Error ? err.message : String(err)
    if (transient && elapsed < PROCESSING_TIMEOUT_MS) {
      state.lastError = message
      await saveState(postId, state, { attempts: (post.attempts ?? 0) + 1 })
      return 'waiting'
    }
    return markFailed(postId, message)
  }
}
