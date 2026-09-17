import { describe, it, expect } from 'vitest'

import { sendOutcome } from './send-status'

describe('sendOutcome', () => {
  it('pedido que falhou é falha, mesmo sem tique nenhum', () => {
    expect(sendOutcome({ status: 'failed', delivery: null })).toEqual({ texto: 'falhou', tom: 'ruim' })
  })

  it('rascunho que envelheceu nunca chegou a sair', () => {
    expect(sendOutcome({ status: 'expired', delivery: null })).toEqual({ texto: 'não saiu', tom: 'ruim' })
  })

  it('o que ainda está na fila não conta como enviado', () => {
    expect(sendOutcome({ status: 'queued', delivery: null }).texto).toBe('na fila')
    expect(sendOutcome({ status: 'pending', delivery: null }).texto).toBe('na fila')
  })

  it('o estado do PEDIDO manda: expirado não vira "entregue" por causa de uma mensagem vizinha', () => {
    expect(sendOutcome({ status: 'expired', delivery: 'delivered' }).texto).toBe('não saiu')
    expect(sendOutcome({ status: 'queued', delivery: 'read' }).texto).toBe('na fila')
  })

  it('tique do WhatsApp vira palavra do dono', () => {
    expect(sendOutcome({ status: 'sent', delivery: 'read' })).toEqual({ texto: 'lida', tom: 'bom' })
    expect(sendOutcome({ status: 'sent', delivery: 'delivered' })).toEqual({ texto: 'entregue', tom: 'bom' })
  })

  it('mensagem recusada DEPOIS de o pedido sair não pode sumir', () => {
    expect(sendOutcome({ status: 'sent', delivery: 'failed' })).toEqual({ texto: 'falhou', tom: 'ruim' })
  })

  it('saiu mas sem tique: diz só o que a gente sabe, não promete entrega', () => {
    expect(sendOutcome({ status: 'sent', delivery: null })).toEqual({ texto: 'enviada', tom: 'ok' })
    expect(sendOutcome({ status: 'sent', delivery: 'sent' })).toEqual({ texto: 'enviada', tom: 'ok' })
  })
})
