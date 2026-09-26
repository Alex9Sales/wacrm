import { describe, expect, it } from 'vitest'
import {
  STORY_REPLY_PREFIX,
  isStoryEngagementOnly,
} from './story-engagement'

// 25/09 — quem posta story e tem "mensagem de fora do horário" ligada
// respondia "estamos fechados" a quem só mandou um 🔥 no story. O que esta
// regra tem que segurar é o LIMITE: carinho cala, pergunta não.

const reply = (t: string) => `${STORY_REPLY_PREFIX}${t}`

describe('reação de story não é pergunta', () => {
  it('emoji sozinho no story não puxa o aviso', () => {
    expect(isStoryEngagementOnly('reply', reply('🔥'))).toBe(true)
    expect(isStoryEngagementOnly('reply', reply('❤️'))).toBe(true)
    expect(isStoryEngagementOnly('reply', reply('👏🏽'))).toBe(true)
    expect(isStoryEngagementOnly('reply', reply('😍😍😍'))).toBe(true)
  })

  it('menção no story também não puxa (a automação de story já responde)', () => {
    expect(isStoryEngagementOnly('mention', '📌 Te mencionou no story')).toBe(true)
  })

  it('resposta a story vazia não puxa', () => {
    expect(isStoryEngagementOnly('reply', reply(''))).toBe(true)
    expect(isStoryEngagementOnly('reply', null)).toBe(true)
  })
})

describe('pergunta no story CONTINUA recebendo o aviso', () => {
  // Aqui está o dinheiro: resposta a story com pergunta é lead, e fora do
  // horário o aviso é exatamente o que deve sair.
  it('pergunta de preço', () => {
    expect(isStoryEngagementOnly('reply', reply('quanto custa?'))).toBe(false)
  })

  it('emoji MAIS palavra é pergunta', () => {
    expect(isStoryEngagementOnly('reply', reply('🔥 tem horário amanhã?'))).toBe(false)
  })

  it('um "?" sozinho é pergunta, não carinho', () => {
    expect(isStoryEngagementOnly('reply', reply('?'))).toBe(false)
  })

  it('número sozinho não é emoji (keycap não conta)', () => {
    expect(isStoryEngagementOnly('reply', reply('10'))).toBe(false)
  })
})

describe('mensagem normal não é afetada', () => {
  it('sem storyContext a regra não opina', () => {
    expect(isStoryEngagementOnly(null, '🔥')).toBe(false)
    expect(isStoryEngagementOnly(undefined, 'bom dia')).toBe(false)
  })
})
