import { describe, it, expect } from 'vitest'
import { cadenceSendMode, cadenceStopReason, resumeSendAtMs, shiftOutOfQuietHours } from './schedule-rules'

describe('cadenceStopReason', () => {
  const pre = [1, 2, 3, 4, 5, 6].map((position) => ({ pipelineId: 'pre', position })) // 1ª..Definição
  const retomada = [{ pipelineId: 'franquia', position: 0 }] // só "Novo lead"

  it('cadência que não anda o card nunca para por aqui (pós-venda entra com card ganho)', () => {
    expect(cadenceStopReason({ deal: { status: 'won', pipelineId: 'x', stagePosition: 9 }, cadenceStages: [] })).toBeNull()
  })

  it('card aberto dentro das etapas da cadência segue', () => {
    expect(cadenceStopReason({ deal: { status: 'open', pipelineId: 'pre', stagePosition: 3 }, cadenceStages: pre })).toBeNull()
    expect(cadenceStopReason({ deal: { status: 'open', pipelineId: 'pre', stagePosition: 0 }, cadenceStages: pre })).toBeNull()
    expect(cadenceStopReason({ deal: { status: 'open', pipelineId: 'franquia', stagePosition: 0 }, cadenceStages: retomada })).toBeNull()
  })

  it('fechado, apagado ou em outro funil para', () => {
    expect(cadenceStopReason({ deal: { status: 'won', pipelineId: 'pre', stagePosition: 2 }, cadenceStages: pre })).toBe('card ganho')
    expect(cadenceStopReason({ deal: { status: 'lost', pipelineId: 'pre', stagePosition: 2 }, cadenceStages: pre })).toBe('card perdido')
    expect(cadenceStopReason({ deal: null, cadenceStages: pre })).toBe('card apagado')
    expect(cadenceStopReason({ deal: { status: 'open', pipelineId: 'franquia', stagePosition: 2 }, cadenceStages: pre })).toBe(
      'card mudou de funil',
    )
  })

  it('o time adiantou o card além da cadência → para', () => {
    // lead parado em "Novo lead" que o vendedor levou pra "Reunião agendada"
    expect(cadenceStopReason({ deal: { status: 'open', pipelineId: 'franquia', stagePosition: 2 }, cadenceStages: retomada })).toBe(
      'card avançou além da cadência',
    )
  })

  describe('cadência presa a uma etapa (todo toque leva pra MESMA etapa)', () => {
    // Sequência da COF: 3 toques, todos "mover para Envio da COF" (posição 3).
    const cof = [3, 3, 3].map((position) => ({ pipelineId: 'franquia', position }))

    it('card na etapa da cadência segue', () => {
      expect(cadenceStopReason({ deal: { status: 'open', pipelineId: 'franquia', stagePosition: 3 }, cadenceStages: cof })).toBeNull()
    })

    it('o time devolveu o card pra trás → para (o próximo toque o puxaria de volta)', () => {
      expect(cadenceStopReason({ deal: { status: 'open', pipelineId: 'franquia', stagePosition: 2 }, cadenceStages: cof })).toBe(
        'card voltou de etapa',
      )
      expect(cadenceStopReason({ deal: { status: 'open', pipelineId: 'franquia', stagePosition: 0 }, cadenceStages: cof })).toBe(
        'card voltou de etapa',
      )
    })

    it('adiante da etapa continua sendo "avançou"', () => {
      expect(cadenceStopReason({ deal: { status: 'open', pipelineId: 'franquia', stagePosition: 4 }, cadenceStages: cof })).toBe(
        'card avançou além da cadência',
      )
    })

    // Revisão 01/10: cadência em que só o 1º toque move ("Em contato") e os
    // outros não — devolver o card depois dela não cancela os toques seguintes.
    it('um toque só que move NÃO conta como presa', () => {
      const um = [{ pipelineId: 'franquia', position: 3 }]
      expect(cadenceStopReason({ deal: { status: 'open', pipelineId: 'franquia', stagePosition: 1 }, cadenceStages: um })).toBeNull()
    })

    it('nenhum toque que move saiu ainda (movingStepsSent = 0): atrás é "ainda não chegou", segue', () => {
      expect(
        cadenceStopReason({
          deal: { status: 'open', pipelineId: 'franquia', stagePosition: 1 },
          cadenceStages: cof,
          movingStepsSent: 0,
        }),
      ).toBeNull()
      expect(
        cadenceStopReason({
          deal: { status: 'open', pipelineId: 'franquia', stagePosition: 1 },
          cadenceStages: cof,
          movingStepsSent: 1,
        }),
      ).toBe('card voltou de etapa')
    })

    it('fechado, apagado ou em outro funil: os motivos de antes vêm primeiro', () => {
      expect(cadenceStopReason({ deal: { status: 'lost', pipelineId: 'franquia', stagePosition: 1 }, cadenceStages: cof })).toBe('card perdido')
      expect(cadenceStopReason({ deal: { status: 'open', pipelineId: 'pre', stagePosition: 1 }, cadenceStages: cof })).toBe('card mudou de funil')
    })

    it('cadência com etapas DIFERENTES nos toques: card atrás da etapa do toque é o caminho normal', () => {
      // pré-vendas: 1ª..Definição — card na 2ª com toques que levam à 3ª, 4ª…
      expect(cadenceStopReason({ deal: { status: 'open', pipelineId: 'pre', stagePosition: 2 }, cadenceStages: pre })).toBeNull()
      expect(cadenceStopReason({ deal: { status: 'open', pipelineId: 'pre', stagePosition: 0 }, cadenceStages: pre })).toBeNull()
    })
  })
})

const SP = 'America/Sao_Paulo' // UTC−3, sem horário de verão
const iso = (ms: number) => new Date(ms).toISOString()

describe('shiftOutOfQuietHours', () => {
  it('de dia não mexe', () => {
    const ms = Date.parse('2026-09-18T17:00:00Z') // 14h em SP
    expect(shiftOutOfQuietHours(ms, SP)).toBe(ms)
  })

  it('de noite vai pro dia seguinte às 9h', () => {
    // 23h de sexta em SP (02h UTC de sábado) → sábado 9h SP = 12h UTC
    expect(iso(shiftOutOfQuietHours(Date.parse('2026-09-19T02:00:00Z'), SP))).toBe('2026-09-19T12:00:00.000Z')
    // 21h em ponto já é silêncio
    expect(iso(shiftOutOfQuietHours(Date.parse('2026-09-19T00:00:00Z'), SP))).toBe('2026-09-19T12:00:00.000Z')
  })

  it('de madrugada vai pras 9h do mesmo dia', () => {
    // 3h de sábado em SP (06h UTC) → 9h SP = 12h UTC do mesmo dia
    expect(iso(shiftOutOfQuietHours(Date.parse('2026-09-19T06:00:00Z'), SP))).toBe('2026-09-19T12:00:00.000Z')
  })

  it('vira o mês certo', () => {
    // 22h de 30/09 em SP (01h UTC de 01/10) → 01/10 9h SP
    expect(iso(shiftOutOfQuietHours(Date.parse('2026-10-01T01:00:00Z'), SP))).toBe('2026-10-01T12:00:00.000Z')
  })

  it('fuso inválido não quebra', () => {
    const ms = Date.parse('2026-09-19T02:00:00Z')
    expect(shiftOutOfQuietHours(ms, 'Nada/Aqui')).toBe(ms)
  })
})

describe('cadenceSendMode', () => {
  const now = Date.parse('2026-09-18T20:00:00Z')

  it('Meta com janela fechada e modelo → modelo', () => {
    expect(cadenceSendMode({ channelTakesTemplates: true, templateName: 'sem_resposta', lastInboundAt: null, now })).toBe('template')
    expect(
      cadenceSendMode({ channelTakesTemplates: true, templateName: 'x', lastInboundAt: '2026-09-17T19:00:00Z', now }),
    ).toBe('template')
  })

  it('Meta com janela ABERTA → texto (é conversa)', () => {
    expect(
      cadenceSendMode({ channelTakesTemplates: true, templateName: 'x', lastInboundAt: '2026-09-18T10:00:00Z', now }),
    ).toBe('text')
  })

  it('sem modelo, ou canal sem modelo (WAHA) → texto', () => {
    expect(cadenceSendMode({ channelTakesTemplates: true, templateName: null, lastInboundAt: null, now })).toBe('text')
    expect(cadenceSendMode({ channelTakesTemplates: true, templateName: '  ', lastInboundAt: null, now })).toBe('text')
    expect(cadenceSendMode({ channelTakesTemplates: false, templateName: 'x', lastInboundAt: null, now })).toBe('text')
  })
})

describe('resumeSendAtMs', () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = Date.UTC(2026, 8, 19, 15, 7)
  const toques = [0, 2, 4, 7, 10].map((d) => d * DAY) // D0, +2d, +4d, +7d, +10d

  it('pausou depois do D0 → o próximo espera os 2 dias normais, não sai agora', () => {
    expect(toques.slice(1).map((ms) => (resumeSendAtMs(ms, toques[0], now) - now) / DAY)).toEqual([2, 4, 7, 10])
  })

  it('pausou depois do +4d → +7d e +10d viram +3d e +6d a partir da retomada', () => {
    expect(resumeSendAtMs(toques[3], toques[2], now) - now).toBe(3 * DAY)
    expect(resumeSendAtMs(toques[4], toques[2], now) - now).toBe(6 * DAY)
  })

  it('nada enviado ainda → o 1º sai em 1 min, como na inscrição', () => {
    expect(resumeSendAtMs(0, 0, now) - now).toBe(60_000)
  })

  it('cadência editada com toque mais cedo que o último enviado → piso de 1 min', () => {
    expect(resumeSendAtMs(DAY, 2 * DAY, now) - now).toBe(60_000)
  })
})
