// ============================================================
// 📸 Publicações no Instagram — parte PURA e client-safe (tipos, validação,
// plano de containers, leitura de erro da Graph). NADA de @/db aqui: este
// módulo é importado pelo compositor no navegador. O publicador de verdade
// (com banco e Graph) está em instagram-publish.ts.
// ============================================================

export type SocialPostKind = 'image' | 'carousel' | 'reel' | 'story'
export type SocialPostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'canceled'

export interface SocialMediaItem {
  url: string
  type: 'image' | 'video'
  name?: string
}

export interface SocialAutomationDraft {
  keywords: string
  matchAny: boolean
  publicReplies: string[]
  dmMessage: string
  dmButtons: { text: string; url: string }[]
  oncePerUser: boolean
  startFlowId: string | null
}

export interface PublishState {
  stage: 'containers' | 'parent' | 'publish'
  startedAt: string
  childIds?: string[]
  containerId?: string
  polls?: number
  lastError?: string
  done?: boolean
}

export const CAPTION_MAX = 2200
export const HASHTAG_MAX = 30
export const CAROUSEL_MIN = 2
export const CAROUSEL_MAX = 10
/** Limite do Instagram pra imagem (JPEG) e o nosso teto de upload pra vídeo. */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024

export const KIND_LABEL: Record<SocialPostKind, string> = {
  image: 'Post',
  carousel: 'Carrossel',
  reel: 'Reels',
  story: 'Story',
}

/** Regras de conteúdo por tipo. Devolve a mensagem do erro ou null. */
export function validatePost(kind: SocialPostKind, media: SocialMediaItem[], caption: string): string | null {
  const images = media.filter((m) => m.type === 'image').length
  const videos = media.filter((m) => m.type === 'video').length
  if (caption.length > CAPTION_MAX) return `A legenda passa de ${CAPTION_MAX} caracteres.`
  const hashtags = (caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length
  if (hashtags > HASHTAG_MAX) return `O Instagram aceita no máximo ${HASHTAG_MAX} hashtags por publicação.`
  switch (kind) {
    case 'image':
      if (media.length !== 1 || images !== 1) return 'Post precisa de exatamente 1 imagem.'
      return null
    case 'reel':
      if (media.length !== 1 || videos !== 1) return 'Reels precisa de exatamente 1 vídeo.'
      return null
    case 'story':
      if (media.length !== 1) return 'Story precisa de 1 imagem ou 1 vídeo.'
      return null
    case 'carousel':
      if (media.length < CAROUSEL_MIN || media.length > CAROUSEL_MAX)
        return `Carrossel precisa de ${CAROUSEL_MIN} a ${CAROUSEL_MAX} itens.`
      return null
    default:
      return 'Tipo de publicação inválido.'
  }
}

export interface ContainerSpec {
  params: Record<string, string | boolean>
}

/** Plano de containers (puro): o que mandar pra Graph em cada etapa. */
export function planContainers(
  kind: SocialPostKind,
  media: SocialMediaItem[],
  caption: string,
  opts: { shareToFeed?: boolean; coverUrl?: string | null } = {},
): { children: ContainerSpec[]; parent: ContainerSpec | null; single: ContainerSpec | null } {
  const first = media[0]
  if (kind === 'carousel') {
    const children = media.map<ContainerSpec>((m) => {
      const params: Record<string, string | boolean> =
        m.type === 'video'
          ? { media_type: 'VIDEO', video_url: m.url, is_carousel_item: true }
          : { image_url: m.url, is_carousel_item: true }
      return { params }
    })
    return { children, parent: { params: { media_type: 'CAROUSEL', caption } }, single: null }
  }
  if (kind === 'reel') {
    const params: Record<string, string | boolean> = {
      media_type: 'REELS',
      video_url: first.url,
      caption,
      share_to_feed: opts.shareToFeed !== false,
    }
    if (opts.coverUrl) params.cover_url = opts.coverUrl
    return { children: [], parent: null, single: { params } }
  }
  if (kind === 'story') {
    const params: Record<string, string | boolean> =
      first.type === 'video' ? { media_type: 'STORIES', video_url: first.url } : { media_type: 'STORIES', image_url: first.url }
    return { children: [], parent: null, single: { params } }
  }
  return { children: [], parent: null, single: { params: { image_url: first.url, caption } } }
}

/** Mensagem legível a partir do corpo de erro da Graph. */
export function graphErrorMessage(body: unknown, httpStatus: number): string {
  const err = (body as { error?: Record<string, unknown> } | null)?.error
  if (!err) return `Instagram respondeu HTTP ${httpStatus}.`
  const parts: string[] = []
  const user = typeof err.error_user_msg === 'string' ? err.error_user_msg : ''
  const msg = typeof err.message === 'string' ? err.message : ''
  parts.push(user || msg || `HTTP ${httpStatus}`)
  if (typeof err.code === 'number' || typeof err.code === 'string') {
    parts.push(`(código ${err.code}${err.error_subcode ? `/${err.error_subcode}` : ''})`)
  }
  return parts.join(' ')
}

/** Vale tentar de novo daqui a pouco? (rede, 5xx, rate limit) */
export function isTransientGraph(httpStatus: number, body: unknown): boolean {
  if (httpStatus === 0 || httpStatus === 429 || httpStatus >= 500) return true
  const code = Number((body as { error?: { code?: unknown } } | null)?.error?.code)
  return [1, 2, 4, 17, 32, 613, 80007].includes(code)
}
