import { describe, expect, it } from 'vitest'

import { broadcastDeleteOrArchive } from './deletion-rule'

// Revisão 15/09: excluir apagava de vez um disparo 'sending' cujo 1º envio
// estava saindo (job ativo, destinatário ainda 'pending' com attempts = 0) —
// o cliente recebia e o histórico sumia.
const nada = { sentCount: 0, nonPendingCount: 0, attemptedCount: 0, activeJob: false }

describe('broadcastDeleteOrArchive', () => {
  it('rascunho e agendado que nunca tentaram: apaga de verdade', () => {
    expect(broadcastDeleteOrArchive({ ...nada, previousStatus: 'draft' })).toBe('delete')
    expect(broadcastDeleteOrArchive({ ...nada, previousStatus: 'scheduled' })).toBe('delete')
  })

  it('cancelado sem tentativa e sem job ativo: apaga', () => {
    expect(broadcastDeleteOrArchive({ ...nada, previousStatus: 'cancelled' })).toBe('delete')
  })

  it('esteve enviando ou pausado: arquiva mesmo com tudo pendente (o bug)', () => {
    expect(broadcastDeleteOrArchive({ ...nada, previousStatus: 'sending' })).toBe('archive')
    expect(broadcastDeleteOrArchive({ ...nada, previousStatus: 'paused' })).toBe('archive')
  })

  it('já terminou (enviado/falhou) ou status desconhecido: arquiva', () => {
    expect(broadcastDeleteOrArchive({ ...nada, previousStatus: 'sent' })).toBe('archive')
    expect(broadcastDeleteOrArchive({ ...nada, previousStatus: 'failed' })).toBe('archive')
    expect(broadcastDeleteOrArchive({ ...nada, previousStatus: null })).toBe('archive')
    expect(broadcastDeleteOrArchive({ ...nada, previousStatus: 'algo-novo' })).toBe('archive')
  })

  it('cancelado com job ativo (envio saindo agora): arquiva', () => {
    expect(broadcastDeleteOrArchive({ ...nada, previousStatus: 'cancelled', activeJob: true })).toBe('archive')
    expect(broadcastDeleteOrArchive({ ...nada, previousStatus: 'scheduled', activeJob: true })).toBe('archive')
  })

  it('alguém tentado (attempts > 0), enviado ou falhado: arquiva', () => {
    expect(broadcastDeleteOrArchive({ ...nada, previousStatus: 'cancelled', attemptedCount: 1 })).toBe('archive')
    expect(broadcastDeleteOrArchive({ ...nada, previousStatus: 'cancelled', nonPendingCount: 1 })).toBe('archive')
    expect(broadcastDeleteOrArchive({ ...nada, previousStatus: 'draft', sentCount: 3 })).toBe('archive')
  })

  it('contagens nulas contam como zero', () => {
    expect(
      broadcastDeleteOrArchive({
        previousStatus: 'draft',
        sentCount: null,
        nonPendingCount: undefined,
        attemptedCount: null,
        activeJob: false,
      }),
    ).toBe('delete')
  })
})
