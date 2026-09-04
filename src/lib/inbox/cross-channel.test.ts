import { describe, expect, it } from 'vitest'

import { crossChannelNote, type OtherChannelTouch } from './cross-channel'

const agora = new Date('2026-09-04T18:00:00-03:00')

function toque(p: Partial<OtherChannelTouch> = {}): OtherChannelTouch {
  return {
    conversationId: 'c1',
    channelName: 'Aliança Gás 2',
    lastCustomerAt: new Date(agora.getTime() - 20 * 60_000).toISOString(),
    lastOutboundText: 'O Ultragaz P-13 está R$ 120,00 na entrega.',
    ...p,
  }
}

describe('aviso de cliente em mais de um canal', () => {
  it('não avisa nada quando o cliente só falou aqui', () => {
    expect(crossChannelNote('Jordy', [], agora)).toBeNull()
  })

  it('diz quem, onde e quando', () => {
    const nota = crossChannelNote('Jordy Arruda', [toque()], agora)!
    expect(nota).toContain('Jordy Arruda')
    expect(nota).toContain('Aliança Gás 2')
    expect(nota).toContain('há 20 min')
  })

  it('mostra o que respondemos no outro canal — é o que o time quer comparar', () => {
    // Caso Jordy: 125 num canal, 120 no outro. A nota tem que deixar ver isso.
    const nota = crossChannelNote('Jordy', [toque()], agora)!
    expect(nota).toContain('R$ 120,00')
  })

  it('conta certo quando são vários canais', () => {
    const nota = crossChannelNote(
      'Gerson',
      [toque(), toque({ channelName: 'Família do Gás 1' })],
      agora,
    )!
    expect(nota).toContain('outros 2 canais')
  })

  it('deixa explícito que é interno — ninguém pode achar que foi pro cliente', () => {
    const nota = crossChannelNote('Jordy', [toque()], agora)!
    expect(nota).toContain('o cliente não vê nada')
  })

  it('funciona sem nome do contato', () => {
    const nota = crossChannelNote(null, [toque()], agora)!
    expect(nota.startsWith('🔀 Este cliente')).toBe(true)
  })

  it('aguenta o outro canal sem resposta nossa ainda', () => {
    const nota = crossChannelNote('Jordy', [toque({ lastOutboundText: null })], agora)!
    expect(nota).toContain('Aliança Gás 2')
    expect(nota).not.toContain('respondemos lá')
  })

  it('corta resposta muito longa em vez de despejar a mensagem inteira', () => {
    const nota = crossChannelNote('Jordy', [toque({ lastOutboundText: 'x'.repeat(400) })], agora)!
    expect(nota.length).toBeLessThan(600)
  })

  it('fala em horas quando já faz tempo', () => {
    const nota = crossChannelNote(
      'Jordy',
      [toque({ lastCustomerAt: new Date(agora.getTime() - 5 * 3_600_000).toISOString() })],
      agora,
    )!
    expect(nota).toContain('há 5h')
  })
})
