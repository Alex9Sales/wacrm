import { describe, expect, it } from 'vitest'

import {
  archivedLine,
  broadcastDeletionMode,
  broadcastProgressLine,
  canManageBroadcast,
  channelWithOwner,
  formatInterval,
  lockedChatHint,
  pauseLine,
} from './detail-text'

// 15/09 (GoLink, Vitor): "Pausado" sem dizer quem, "Chat não disponível" sem
// dizer onde, e "Excluir" apagando o histórico de quem já tinha recebido.
const TZ = 'America/Sao_Paulo' // UTC-3
const NOW = new Date('2026-09-15T13:00:00Z') // 10:00 em São Paulo
const MIN = 60_000

describe('formatInterval', () => {
  it('minutos com vírgula e segundos abaixo de 1 min', () => {
    expect(formatInterval(2 * MIN)).toBe('2 min')
    expect(formatInterval(1.5 * MIN)).toBe('1,5 min')
    expect(formatInterval(40_000)).toBe('40 s')
  })
})

describe('broadcastProgressLine', () => {
  const base = {
    status: 'sending',
    pendingCount: 40,
    nextSlotAt: '2026-09-15T13:30:00Z',
    lastSlotAt: '2026-09-15T14:48:00Z',
    intervalMs: 2 * MIN,
    drip: false,
    now: NOW,
    timeZone: TZ,
  }

  it('próximo envio, ritmo e fim no mesmo dia', () => {
    expect(broadcastProgressLine(base)).toBe(
      'Próximo envio às 10:30 · 1 a cada 2 min · termina por volta de 11:48',
    )
  })

  it('fim em outro dia mostra a data', () => {
    expect(
      broadcastProgressLine({ ...base, drip: true, intervalMs: 12 * MIN, lastSlotAt: '2026-09-16T12:00:00Z' }),
    ).toBe('Próximo envio às 10:30 · 1 a cada 12 min no horário comercial · termina em 16/09 por volta de 09:00')
  })

  it('horário já vencido vira "agora"', () => {
    expect(broadcastProgressLine({ ...base, nextSlotAt: '2026-09-15T12:59:00Z' })).toMatch(/^Próximo envio agora · /)
  })

  it('pausado não promete horário', () => {
    expect(broadcastProgressLine({ ...base, status: 'paused' })).toBe(
      'Faltam 40 envios · ao retomar, 1 a cada 2 min a partir daquele momento',
    )
  })

  it('rajada sem horários gravados: só quantos faltam', () => {
    expect(
      broadcastProgressLine({ ...base, nextSlotAt: null, lastSlotAt: null, intervalMs: 0, pendingCount: 1 }),
    ).toBe('Falta 1 envio')
  })

  it('ninguém pendente ou disparo encerrado: nada', () => {
    expect(broadcastProgressLine({ ...base, pendingCount: 0 })).toBeNull()
    expect(broadcastProgressLine({ ...base, status: 'cancelled' })).toBeNull()
  })
})

describe('pauseLine', () => {
  it('pausa manual com nome e hora', () => {
    expect(
      pauseLine({ pausedByName: 'Vitor', pausedAt: '2026-09-15T13:24:00Z', pauseReason: 'manual', now: NOW, timeZone: TZ }),
    ).toBe('Pausado por Vitor às 10:24')
  })

  it('pausa de outro dia mostra a data', () => {
    expect(
      pauseLine({ pausedByName: 'Vitor', pausedAt: '2026-09-14T13:24:00Z', pauseReason: 'manual', now: NOW, timeZone: TZ }),
    ).toBe('Pausado por Vitor em 14/09 às 10:24')
  })

  it('automático diz o motivo', () => {
    expect(
      pauseLine({ pausedByName: null, pausedAt: '2026-09-15T13:24:00Z', pauseReason: 'reputation', now: NOW, timeZone: TZ }),
    ).toMatch(/^Pausado automaticamente às 10:24: o WhatsApp começou a recusar/)
    expect(pauseLine({ pausedByName: null, pausedAt: null, pauseReason: 'session', now: NOW, timeZone: TZ })).toBe(
      'Pausado automaticamente: a conexão do WhatsApp deste número caiu.',
    )
  })

  it('linha antiga sem rastro', () => {
    expect(pauseLine({ pausedByName: null, pausedAt: null, pauseReason: null, now: NOW })).toBe('Pausado')
  })
})

describe('archivedLine', () => {
  it('quem e quando', () => {
    expect(archivedLine({ archivedByName: 'Vitor', archivedAt: '2026-09-15T13:24:00Z', now: NOW, timeZone: TZ })).toBe(
      'Arquivado por Vitor em 15/09',
    )
    expect(archivedLine({ archivedByName: null, archivedAt: '2025-09-15T13:24:00Z', now: NOW, timeZone: TZ })).toBe(
      'Arquivado em 15/09/2025',
    )
  })
})

describe('lockedChatHint', () => {
  it('enviado no número de outra pessoa', () => {
    expect(lockedChatHint({ recipientStatus: 'delivered', channelName: 'Atendimento', holderName: 'Leonardo' })).toBe(
      'Enviado ✓ — a conversa está no número Atendimento (Leonardo). Peça a um admin pra atribuir a você.',
    )
  })

  it('falhou não diz "Enviado"', () => {
    expect(lockedChatHint({ recipientStatus: 'failed', channelName: null, holderName: null })).toBe(
      'A conversa está com outra pessoa. Peça a um admin pra atribuir a você.',
    )
  })

  it('channelWithOwner sem dono', () => {
    expect(channelWithOwner('Comercial', null)).toBe('Comercial')
    expect(channelWithOwner(null, 'Leonardo')).toBeNull()
  })
})

describe('canManageBroadcast / broadcastDeletionMode', () => {
  it('quem criou ou supervisor para cima', () => {
    expect(canManageBroadcast({ actorUserId: 'vitor', actorRole: 'agent', creatorUserId: 'vitor' })).toBe(true)
    expect(canManageBroadcast({ actorUserId: 'joao', actorRole: 'agent', creatorUserId: 'vitor' })).toBe(false)
    expect(canManageBroadcast({ actorUserId: 'rafael', actorRole: 'supervisor', creatorUserId: 'vitor' })).toBe(true)
    expect(canManageBroadcast({ actorUserId: null, actorRole: null, creatorUserId: 'vitor' })).toBe(false)
  })

  it('já saiu pra alguém → arquiva; nunca saiu → apaga', () => {
    expect(broadcastDeletionMode({ sentCount: 3, nonPendingCount: 3 })).toBe('archive')
    // Falhou conta como tentativa: fica o histórico.
    expect(broadcastDeletionMode({ sentCount: 0, nonPendingCount: 1 })).toBe('archive')
    expect(broadcastDeletionMode({ sentCount: 0, nonPendingCount: 0 })).toBe('delete')
  })
})
