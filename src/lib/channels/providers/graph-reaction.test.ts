import { describe, expect, it, vi } from 'vitest'
import { reactionCandidates, sendGraphReaction } from './graph-reaction'

// 25/09 — Instagram/Messenger declaravam `reactions: true` sem envio nenhum.
// Aqui interessa o PAYLOAD (é a aposta do módulo: a doc da Meta não diz se
// `reaction` quer nome ou emoji) e a remoção da reação.

const base = {
  url: 'https://graph.facebook.com/v21.0/IG123/messages',
  token: 'tok',
  recipientId: 'IGSID9',
  targetMessageId: 'mid.abc',
}

// O tipo importa: sem ele o vi.fn infere parâmetros como tupla VAZIA e
// `calls[0][2]` (o corpo do POST — justo o que estes testes conferem) nem
// compila. O typecheck do CI cobre os testes; o `tsc` de um arquivo só, não.
type Post = (url: string, token: string, body: unknown) => Promise<unknown>
const postOk = () => vi.fn<Post>(async () => ({}))

describe('payload da reação', () => {
  it('emoji vazio remove a reação (unreact, sem campo reaction)', async () => {
    const post = postOk()
    await sendGraphReaction({ ...base, emoji: '', post })
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][2]).toEqual({
      recipient: { id: 'IGSID9' },
      sender_action: 'unreact',
      payload: { message_id: 'mid.abc' },
    })
  })

  it('emoji conhecido vai pelo NOME — o único formato que a doc mostra', async () => {
    const post = postOk()
    await sendGraphReaction({ ...base, emoji: '❤️', post })
    expect(post.mock.calls[0][2]).toMatchObject({
      sender_action: 'react',
      payload: { message_id: 'mid.abc', reaction: 'love' },
    })
  })

  it('emoji sem nome vai cru — senão 🙏 não teria como sair', async () => {
    const post = postOk()
    await sendGraphReaction({ ...base, emoji: '🙏', post })
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][2]).toMatchObject({
      payload: { reaction: '🙏' },
    })
  })
})

describe('quando a API recusa o formato', () => {
  it('nome recusado tenta o emoji cru antes de desistir', async () => {
    const post = vi.fn<Post>()
      .mockRejectedValueOnce(new Error('instagram send falhou: 400 invalid reaction'))
      .mockResolvedValueOnce({})
    await sendGraphReaction({ ...base, emoji: '👍', post })
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[0][2]).toMatchObject({ payload: { reaction: 'like' } })
    expect(post.mock.calls[1][2]).toMatchObject({ payload: { reaction: '👍' } })
  })

  it('os dois recusados relançam o PRIMEIRO erro (descreve a aposta principal)', async () => {
    const post = vi.fn<Post>()
      .mockRejectedValueOnce(new Error('primeiro'))
      .mockRejectedValueOnce(new Error('segundo'))
    await expect(
      sendGraphReaction({ ...base, emoji: '👍', post }),
    ).rejects.toThrow('primeiro')
  })

  it('unreact que falha NÃO é tentado de novo — não há formato alternativo', async () => {
    const post = vi.fn<Post>().mockRejectedValue(new Error('nada a remover'))
    await expect(
      sendGraphReaction({ ...base, emoji: '', post }),
    ).rejects.toThrow('nada a remover')
    expect(post).toHaveBeenCalledTimes(1)
  })
})

describe('cada API pede um formato', () => {
  // graph.instagram.com documenta `"reaction": "<emoji>"`; a Messenger
  // Platform documenta o nome. Mandar o provável primeiro poupa uma viagem.
  it('login do Instagram → emoji primeiro', () => {
    expect(reactionCandidates('❤️', true)).toEqual(['❤️', 'love'])
  })

  it('Messenger → nome primeiro', () => {
    expect(reactionCandidates('❤️', false)).toEqual(['love', '❤️'])
  })

  it('emoji sem nome não muda com a preferência', () => {
    expect(reactionCandidates('🙏', true)).toEqual(['🙏'])
    expect(reactionCandidates('🙏', false)).toEqual(['🙏'])
  })
})

describe('mapa de nomes', () => {
  it('cobre os 6 emojis rápidos da tela', () => {
    // A tela oferece 👍 ❤️ 😂 😮 😢 🙏 (message-actions.tsx). O 🙏 não tem
    // nome na Meta — sai cru, e é isso que o teste registra.
    expect(reactionCandidates('👍')[0]).toBe('like')
    expect(reactionCandidates('❤️')[0]).toBe('love')
    expect(reactionCandidates('😂')[0]).toBe('smile')
    expect(reactionCandidates('😮')[0]).toBe('wow')
    expect(reactionCandidates('😢')[0]).toBe('sad')
    expect(reactionCandidates('🙏')).toEqual(['🙏'])
  })
})
