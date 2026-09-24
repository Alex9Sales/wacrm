import { describe, expect, it } from 'vitest'

import {
  ACTIVE_CHANNEL_WINDOW_MS,
  sessionVerdict,
  verdictReason,
  ZOMBIE_SILENCE_MS,
} from './session-health-rules'

// 24/09: em 24h o monitor deu 72 reinícios — 36 em sessões WORKING, derrubadas
// por 30 a 35 minutos de silêncio. Canais reais que apanharam: "MARATAIZES"
// (3x), "FISCAL", "Familia do Gas 2", "Central inicial IA", "João" da GoLink.

const min = (n: number) => n * 60_000
const h = (n: number) => n * 60 * 60_000

describe('canal quieto NÃO é canal doente (os 36 reinícios indevidos)', () => {
  it.each([31, 33, 34, 35])('WORKING com %i min de silêncio continua saudável', (m) => {
    expect(sessionVerdict({ wahaStatus: 'WORKING', activityAgeMs: min(m), trafficAgeMs: min(m) })).toBe('healthy')
  })

  it('silêncio longo num canal PARADO também não se reinicia — não conserta nada', () => {
    expect(
      sessionVerdict({ wahaStatus: 'WORKING', activityAgeMs: h(9), trafficAgeMs: h(40) }),
    ).toBe('healthy')
    // Canal que nunca trocou mensagem nenhuma.
    expect(sessionVerdict({ wahaStatus: 'WORKING', activityAgeMs: h(9), trafficAgeMs: null })).toBe('healthy')
  })

  it('sem saber a idade da atividade, WORKING é a palavra do WhatsApp: saudável', () => {
    expect(sessionVerdict({ wahaStatus: 'WORKING', activityAgeMs: null, trafficAgeMs: min(5) })).toBe('healthy')
  })
})

describe('o zumbi de verdade continua sendo pego', () => {
  it('WORKING, mudo há horas, num canal que se moveu hoje', () => {
    expect(sessionVerdict({ wahaStatus: 'WORKING', activityAgeMs: h(4), trafficAgeMs: h(4) })).toBe('zombie')
  })

  it('logo depois do limite já vale, se o canal está ativo', () => {
    expect(
      sessionVerdict({
        wahaStatus: 'WORKING',
        activityAgeMs: ZOMBIE_SILENCE_MS + 1,
        trafficAgeMs: ACTIVE_CHANNEL_WINDOW_MS - 1,
      }),
    ).toBe('zombie')
  })

  it('exatamente no limite ainda é saudável (a borda não derruba canal)', () => {
    expect(
      sessionVerdict({ wahaStatus: 'WORKING', activityAgeMs: ZOMBIE_SILENCE_MS, trafficAgeMs: min(10) }),
    ).toBe('healthy')
  })
})

describe('sessão fora do ar continua sendo tratada na hora', () => {
  it.each(['FAILED', 'STOPPED', 'UNREACHABLE', 'UNKNOWN', 'SCAN_QR_CODE'])('%s = down', (st) => {
    expect(sessionVerdict({ wahaStatus: st, activityAgeMs: null, trafficAgeMs: min(1) })).toBe('down')
  })

  it('FAILED não espera silêncio nenhum — cai na hora, mesmo com tráfego agora', () => {
    expect(sessionVerdict({ wahaStatus: 'FAILED', activityAgeMs: 0, trafficAgeMs: 0 })).toBe('down')
  })
})

describe('o motivo que vai pro log e pro aviso do dono', () => {
  it('diz o status quando a sessão caiu', () => {
    const s = { wahaStatus: 'FAILED', activityAgeMs: null, trafficAgeMs: null }
    expect(verdictReason(s, 'down')).toBe('sessão FAILED')
  })

  it('no zumbi, explica que o canal anda mas a sessão não entrega', () => {
    const s = { wahaStatus: 'WORKING', activityAgeMs: h(4), trafficAgeMs: h(4) }
    const txt = verdictReason(s, 'zombie')
    expect(txt).toContain('WORKING mas sem entregar')
    expect(txt).toContain('240min')
  })
})
