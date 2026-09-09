import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChannelCtx } from '../provider'
import {
  createMediaComment,
  deleteComment,
  fetchInstagramAccountProfile,
  instagramProvider,
  listMediaComments,
  setCommentHidden,
} from './instagram'

const ch: ChannelCtx = {
  id: 'ch1',
  accountId: 'acc1',
  provider: 'instagram',
  name: 'Instagram @fluxia',
  phoneNumber: null,
  credentials: { accessToken: 'tok' },
  providerMeta: { ig_id: '1789' },
  settings: {},
  webhookSecret: 's',
}

type Call = { url: string; init?: RequestInit }
function mockFetch(reply: unknown, ok = true) {
  const calls: Call[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return { ok, status: ok ? 200 : 400, json: async () => reply } as Response
  })
  vi.stubGlobal('fetch', fn)
  return calls
}
const bodyOf = (c: Call) => JSON.parse(String(c.init?.body ?? '{}')) as Record<string, unknown>

afterEach(() => vi.unstubAllGlobals())

describe('Instagram — tag HUMAN_AGENT fora da janela de 24h (09/09)', () => {
  it('sem a flag manda RESPONSE (janela aberta)', async () => {
    const calls = mockFetch({ message_id: 'm1' })
    await instagramProvider.sendText(ch, 'igsid1', 'oi')
    expect(calls).toHaveLength(1)
    expect(bodyOf(calls[0])).toMatchObject({ recipient: { id: 'igsid1' }, messaging_type: 'RESPONSE', message: { text: 'oi' } })
    expect(bodyOf(calls[0])).not.toHaveProperty('tag')
  })

  it('com humanAgent manda MESSAGE_TAG + HUMAN_AGENT (texto e mídia, legenda inclusa)', async () => {
    const calls = mockFetch({ message_id: 'm2' })
    await instagramProvider.sendText(ch, 'igsid1', 'oi', { humanAgent: true })
    await instagramProvider.sendMedia(
      ch,
      'igsid1',
      { kind: 'image', url: 'https://x/y.jpg', caption: 'legenda' },
      { humanAgent: true },
    )
    expect(calls).toHaveLength(3)
    for (const c of calls) {
      expect(bodyOf(c)).toMatchObject({ messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' })
    }
  })
})

describe('Instagram — perfil e moderação de comentários (revisão da Meta, 09/09)', () => {
  it('perfil ao vivo: pede os campos certos e mapeia', async () => {
    const calls = mockFetch({
      id: '1789',
      username: 'fluxia.oficial',
      name: 'Fluxia',
      biography: 'CRM com IA',
      followers_count: 1234,
      follows_count: 56,
      media_count: 78,
      profile_picture_url: 'https://p/pic.jpg',
    })
    const p = await fetchInstagramAccountProfile(ch)
    expect(calls[0].url).toContain('/1789?fields=id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website')
    expect(p).toMatchObject({ username: 'fluxia.oficial', followersCount: 1234, mediaCount: 78, website: null })
  })

  it('comentários: lista com respostas, username via from quando faltar', async () => {
    mockFetch({
      data: [
        {
          id: 'c1',
          text: 'top',
          from: { username: 'joao' },
          timestamp: '2026-09-09T10:00:00+0000',
          hidden: false,
          like_count: 2,
          replies: { data: [{ id: 'c1r', text: 'valeu!', username: 'fluxia.oficial', hidden: false }] },
        },
        { id: 'c2', text: 'spam', username: 'bot', hidden: true },
      ],
    })
    const list = await listMediaComments(ch, 'media1')
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ id: 'c1', username: 'joao', likeCount: 2, hidden: false })
    expect(list[0].replies[0]).toMatchObject({ id: 'c1r', username: 'fluxia.oficial' })
    expect(list[1]).toMatchObject({ id: 'c2', hidden: true, replies: [] })
  })

  it('comentar / ocultar / apagar batem nos endpoints certos', async () => {
    const calls = mockFetch({ id: 'newc', success: true })
    await createMediaComment(ch, 'media1', 'olá')
    await setCommentHidden(ch, 'c2', true)
    await deleteComment(ch, 'c2')
    expect(calls[0].url).toMatch(/\/media1\/comments$/)
    expect(bodyOf(calls[0])).toEqual({ message: 'olá' })
    expect(calls[1].url).toMatch(/\/c2$/)
    expect(bodyOf(calls[1])).toEqual({ hide: true })
    expect(calls[2].url).toMatch(/\/c2$/)
    expect(calls[2].init?.method).toBe('DELETE')
  })

  it('erro da Graph vira exceção com a mensagem da Meta', async () => {
    mockFetch({ error: { message: '(#10) Application does not have permission for this action' } }, false)
    await expect(deleteComment(ch, 'c9')).rejects.toThrow(/does not have permission/)
  })
})
