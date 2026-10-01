import { describe, expect, it } from 'vitest'
import {
  HANDOFF_NOTE_PREFIX,
  HANDOFF_PAUSE_MAX_MINUTES,
  aiPauseActive,
  formatPauseClock,
  handoffAlertMotivo,
  handoffContextInstruction,
  handoffNoteSuffix,
  handoffOutcome,
} from './handoff-pause'

// 29/09 (reunião, caso Zelo): o [[HANDOFF]] desligava a IA de vez e o funil
// travava. Estas são as regras de quando ela PAUSA e quando ainda desliga.
const base = { pauseMinutes: 30, lose: false, crossFunnel: false, win: false, priorHandoffs24h: 0 }

describe('handoffOutcome', () => {
  it('pausa configurada, 1ª transferência, sem perda nem troca de funil → pausa', () => {
    expect(handoffOutcome(base)).toEqual({ kind: 'pause', minutes: 30 })
  })

  it('sem pausa (0, negativo, ausente, lixo) → desliga como antes', () => {
    for (const pauseMinutes of [0, -5, null, undefined, Number.NaN]) {
      expect(handoffOutcome({ ...base, pauseMinutes })).toEqual({ kind: 'disable', reason: 'off' })
    }
  })

  it('perda → desliga (não há o que retomar), mesmo com ganho junto', () => {
    expect(handoffOutcome({ ...base, lose: true })).toEqual({ kind: 'disable', reason: 'lose' })
    expect(handoffOutcome({ ...base, lose: true, win: true })).toEqual({ kind: 'disable', reason: 'lose' })
  })

  it('troca de funil SEM ganho (lead de serviço/emprego) → desliga', () => {
    expect(handoffOutcome({ ...base, crossFunnel: true })).toEqual({ kind: 'disable', reason: 'cross_funnel' })
  })

  it('troca de funil COM ganho (qualificado indo pra venda) → pausa', () => {
    expect(handoffOutcome({ ...base, crossFunnel: true, win: true })).toEqual({ kind: 'pause', minutes: 30 })
  })

  it('2ª transferência em 24h → desliga (anti-laço)', () => {
    expect(handoffOutcome({ ...base, priorHandoffs24h: 1 })).toEqual({ kind: 'disable', reason: 'repeat' })
    expect(handoffOutcome({ ...base, priorHandoffs24h: 7 })).toEqual({ kind: 'disable', reason: 'repeat' })
  })

  it('"off" vem antes de tudo: sem pausa, o motivo é sempre "off" (nota sai como antes)', () => {
    expect(
      handoffOutcome({ pauseMinutes: 0, lose: true, crossFunnel: true, win: false, priorHandoffs24h: 3 }),
    ).toEqual({ kind: 'disable', reason: 'off' })
  })

  it('minutos: fração arredonda pra baixo (mínimo 1) e o teto é 24h', () => {
    expect(handoffOutcome({ ...base, pauseMinutes: 12.9 })).toEqual({ kind: 'pause', minutes: 12 })
    expect(handoffOutcome({ ...base, pauseMinutes: 0.4 })).toEqual({ kind: 'pause', minutes: 1 })
    expect(handoffOutcome({ ...base, pauseMinutes: 99_999 })).toEqual({
      kind: 'pause',
      minutes: HANDOFF_PAUSE_MAX_MINUTES,
    })
  })
})

describe('textos da nota e do aviso', () => {
  it('pausa: complemento da nota e {{motivo}} dizem que volta sozinha', () => {
    const o = { kind: 'pause', minutes: 45 } as const
    expect(handoffNoteSuffix(o)).toBe(
      ' — IA pausada por 45 min (volta sozinha se a pessoa escrever e ninguém responder)',
    )
    expect(handoffAlertMotivo(o)).toBe(
      'A IA pediu um humano nesta conversa — ela fica pausada por 45 min e volta sozinha se a pessoa escrever e ninguém responder',
    )
  })

  it('desligada sem pausa configurada: tudo exatamente como antes', () => {
    const o = { kind: 'disable', reason: 'off' } as const
    expect(`${HANDOFF_NOTE_PREFIX}${handoffNoteSuffix(o)}`).toBe('🙋 *A IA pediu um humano*')
    expect(handoffAlertMotivo(o)).toBe('A IA pediu um humano nesta conversa')
  })

  it('desligada apesar da pausa: diz o porquê', () => {
    expect(handoffNoteSuffix({ kind: 'disable', reason: 'lose' })).toContain('marcado como perdido')
    expect(handoffNoteSuffix({ kind: 'disable', reason: 'cross_funnel' })).toContain('outro funil')
    expect(handoffNoteSuffix({ kind: 'disable', reason: 'repeat' })).toContain('2ª transferência em 24h')
    expect(handoffAlertMotivo({ kind: 'disable', reason: 'repeat' })).toBe(
      'A IA pediu um humano nesta conversa — a IA foi desligada nesta conversa (é a 2ª transferência em 24h)',
    )
  })

  it('o prefixo nunca muda (contador e contexto procuram por ele)', () => {
    expect(HANDOFF_NOTE_PREFIX).toBe('🙋 *A IA pediu um humano*')
  })
})

describe('aiPauseActive', () => {
  const now = Date.parse('2026-10-01T15:00:00.000Z')
  it('futuro = pausada; passado, agora, nulo e lixo = não', () => {
    expect(aiPauseActive('2026-10-01T15:30:00.000Z', now)).toBe(true)
    expect(aiPauseActive(new Date('2026-10-01T15:00:01.000Z'), now)).toBe(true)
    expect(aiPauseActive('2026-10-01T14:59:00.000Z', now)).toBe(false)
    expect(aiPauseActive('2026-10-01T15:00:00.000Z', now)).toBe(false)
    expect(aiPauseActive(null, now)).toBe(false)
    expect(aiPauseActive(undefined, now)).toBe(false)
    expect(aiPauseActive('não é data', now)).toBe(false)
  })
})

describe('contexto pós-transferência', () => {
  it('HH:MM no fuso da conta (fuso inválido cai em São Paulo)', () => {
    expect(formatPauseClock('2026-10-01T17:05:00.000Z', 'America/Sao_Paulo')).toBe('14:05')
    expect(formatPauseClock('2026-10-01T17:05:00.000Z', 'America/Manaus')).toBe('13:05')
    expect(formatPauseClock('2026-10-01T17:05:00.000Z', 'Fuso/Inexistente')).toBe('14:05')
  })

  it('mesmo dia: "today at HH:MM"; com as regras de não recomeçar e de só re-transferir se insistir', () => {
    const txt = handoffContextInstruction({
      handoffAt: '2026-10-01T17:05:00.000Z',
      timezone: 'America/Sao_Paulo',
      now: new Date('2026-10-01T18:00:00.000Z'),
    })
    expect(txt).toContain('today at 14:05')
    expect(txt).toContain('Do NOT restart the qualification')
    expect(txt).toContain('the team has been notified')
    expect(txt).toContain('Only emit [[HANDOFF]] again if the customer insists')
  })

  it('outro dia (a janela é de 24h): diz QUAL dia', () => {
    const txt = handoffContextInstruction({
      handoffAt: '2026-10-01T23:30:00.000Z', // 20:30 de 01/10 em São Paulo
      timezone: 'America/Sao_Paulo',
      now: new Date('2026-10-02T12:00:00.000Z'),
    })
    expect(txt).toContain('on 01/10 at 20:30')
  })
})
