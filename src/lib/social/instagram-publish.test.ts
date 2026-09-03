import { describe, expect, it } from 'vitest'

import { graphErrorMessage, isTransientGraph, planContainers, validatePost } from './social-shared'

const img = (n: number) => ({ url: `https://crm.example/api/files/media/a/${n}.jpg`, type: 'image' as const })
const vid = (n: number) => ({ url: `https://crm.example/api/files/media/a/${n}.mp4`, type: 'video' as const })

describe('validatePost', () => {
  it('post = 1 imagem; reels = 1 vídeo; story = 1 mídia; carrossel 2–10', () => {
    expect(validatePost('image', [img(1)], 'oi')).toBeNull()
    expect(validatePost('image', [vid(1)], 'oi')).toMatch(/1 imagem/)
    expect(validatePost('reel', [vid(1)], '')).toBeNull()
    expect(validatePost('reel', [img(1)], '')).toMatch(/1 vídeo/)
    expect(validatePost('story', [img(1)], '')).toBeNull()
    expect(validatePost('story', [], '')).toMatch(/Story/)
    expect(validatePost('carousel', [img(1)], '')).toMatch(/2 a 10/)
    expect(validatePost('carousel', [img(1), vid(2)], '')).toBeNull()
  })
  it('limita legenda e hashtags', () => {
    expect(validatePost('image', [img(1)], 'x'.repeat(2201))).toMatch(/2200/)
    expect(validatePost('image', [img(1)], Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' '))).toMatch(/30 hashtags/)
  })
})

describe('planContainers', () => {
  it('carrossel: 1 container por item + pai CAROUSEL com a legenda', () => {
    const plan = planContainers('carousel', [img(1), vid(2)], 'legenda')
    expect(plan.children).toHaveLength(2)
    expect(plan.children[0].params).toEqual({ image_url: img(1).url, is_carousel_item: true })
    expect(plan.children[1].params).toEqual({ media_type: 'VIDEO', video_url: vid(2).url, is_carousel_item: true })
    expect(plan.parent?.params).toEqual({ media_type: 'CAROUSEL', caption: 'legenda' })
    expect(plan.single).toBeNull()
  })
  it('reels: REELS + share_to_feed + capa opcional', () => {
    const plan = planContainers('reel', [vid(1)], 'c', { shareToFeed: false, coverUrl: 'https://x/c.jpg' })
    expect(plan.single?.params).toEqual({ media_type: 'REELS', video_url: vid(1).url, caption: 'c', share_to_feed: false, cover_url: 'https://x/c.jpg' })
  })
  it('story de vídeo e post de imagem', () => {
    expect(planContainers('story', [vid(1)], '').single?.params).toEqual({ media_type: 'STORIES', video_url: vid(1).url })
    expect(planContainers('image', [img(1)], 'oi').single?.params).toEqual({ image_url: img(1).url, caption: 'oi' })
  })
})

describe('erros da Graph', () => {
  it('mensagem legível com código', () => {
    expect(graphErrorMessage({ error: { message: 'Invalid parameter', code: 100, error_subcode: 2207026 } }, 400)).toBe(
      'Invalid parameter (código 100/2207026)',
    )
    expect(graphErrorMessage({}, 502)).toMatch(/HTTP 502/)
  })
  it('transiente = rede/5xx/429/rate-limit; permanente = 4xx com código de validação', () => {
    expect(isTransientGraph(503, {})).toBe(true)
    expect(isTransientGraph(429, {})).toBe(true)
    expect(isTransientGraph(400, { error: { code: 4 } })).toBe(true)
    expect(isTransientGraph(400, { error: { code: 100 } })).toBe(false)
    expect(isTransientGraph(403, { error: { code: 10 } })).toBe(false)
  })
})
