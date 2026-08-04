import { describe, it, expect, vi } from 'vitest'

/** Minimal fake matching the Drizzle chain in buildConversationContext:
 *  select().from().where().orderBy().limit() → rows. */
const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(h.rows.map((r) => ({ ...r }))),
  }
  return {
    ...actual,
    db: { select: () => chain },
  }
})

import { buildConversationContext } from './context'

function fakeDb(rows: Record<string, unknown>[]): void {
  h.rows = rows
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    fakeDb([
      { senderType: 'customer', contentText: 'third' },
      { senderType: 'agent', contentText: 'second' },
      { senderType: 'customer', contentText: 'first' },
    ])
    const out = await buildConversationContext('conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    fakeDb([{ senderType: 'bot', contentText: 'auto reply' }])
    const out = await buildConversationContext('conv-1')
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    fakeDb([
      { senderType: 'customer', contentText: '   ' },
      { senderType: 'customer', contentText: null },
      { senderType: 'customer', contentText: 'real' },
    ])
    const out = await buildConversationContext('conv-1')
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  it('includes a customer image via its vision description, prefixed [imagem]', async () => {
    fakeDb([
      {
        senderType: 'customer',
        contentType: 'image',
        contentText: '[image]',
        transcription: 'Foto de um botijão de gás P13 azul.',
      },
    ])
    const out = await buildConversationContext('conv-1')
    expect(out).toEqual([
      { role: 'user', content: '[imagem] Foto de um botijão de gás P13 azul.' },
    ])
  })

  it('drops an image with no description (not yet understood)', async () => {
    fakeDb([
      { senderType: 'customer', contentType: 'image', contentText: '[image]', transcription: null },
      { senderType: 'customer', contentType: 'text', contentText: 'oi' },
    ])
    const out = await buildConversationContext('conv-1')
    expect(out).toEqual([{ role: 'user', content: 'oi' }])
  })
})
