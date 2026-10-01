import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

const h = vi.hoisted(() => ({
  execute: vi.fn<(q: unknown) => Promise<{ rows: unknown[] }>>(async () => ({ rows: [] })),
}))
vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  return { ...actual, db: { execute: h.execute } }
})

import {
  agenteCobreAConversa,
  degrausJaVencidos,
  escolherAgenteDosLembretes,
  lembretesDoCompromisso,
  readFollowUpConfig,
} from './followup'

/**
 * 01/10 — confirmação ao agendar × lembrete da IA. Marcado hoje para amanhã
 * cedo, o degrau "24h antes" já venceu quando o compromisso nasce: sem
 * carimbar, o paciente recebia a confirmação e, um minuto depois, o lembrete
 * dizendo a mesma coisa. Estes testes fixam QUANTOS degraus a confirmação
 * cobre e QUAL agente responde pelos lembretes (a mesma regra da varredura).
 *
 * Ids fictícios; nenhum dado de paciente.
 */

const H = 3_600_000
const AGORA = new Date('2026-10-01T15:00:00.000Z')
const em = (horas: number) => new Date(AGORA.getTime() + horas * H).toISOString()

// O jeito mais comum na clínica: 24h antes e "no dia" (2h antes), mais um
// "como foi?" depois.
const { meetingReminders: DEGRAUS } = readFollowUpConfig({
  enabled: true,
  meetingReminders: [
    { when: 'after', offsetValue: 4, offsetUnit: 'hours' },
    { when: 'before', offsetValue: 2, offsetUnit: 'hours' },
    { when: 'before', offsetValue: 24, offsetUnit: 'hours' },
  ],
})

describe('quantos degraus a confirmação já cobriu', () => {
  it('consulta daqui a 20h: o de 24h venceu (1); o "no dia" segue pendente', () => {
    expect(degrausJaVencidos(DEGRAUS, em(20), AGORA)).toBe(1)
  })

  it('consulta daqui a 3 dias: nada venceu, os dois lembretes saem normalmente', () => {
    expect(degrausJaVencidos(DEGRAUS, em(72), AGORA)).toBe(0)
  })

  it('consulta daqui a 1h: os dois "antes" venceram; o "depois" nunca conta', () => {
    expect(degrausJaVencidos(DEGRAUS, em(1), AGORA)).toBe(2)
  })

  it('na hora exata do degrau já conta como vencido (mesma regra da varredura: agora >= hora)', () => {
    expect(degrausJaVencidos(DEGRAUS, em(24), AGORA)).toBe(1)
  })

  it('sem degraus, ou horário ilegível: 0 (não mexe em nada)', () => {
    expect(degrausJaVencidos([], em(1), AGORA)).toBe(0)
    expect(degrausJaVencidos(DEGRAUS, 'não é data', AGORA)).toBe(0)
  })

  it('a ordem da configuração não importa (a varredura ordena pelo horário)', () => {
    expect(degrausJaVencidos([...DEGRAUS].reverse(), em(20), AGORA)).toBe(1)
  })
})

describe('qual agente responde pelos lembretes da conversa', () => {
  const comLembretes = { enabled: true, meetingReminders: [{ when: 'before', offsetValue: 24, offsetUnit: 'hours' }] }
  const agente = (id: string, extra: Partial<{ auto_reply_channel_ids: string[]; is_default: boolean; sole_active: boolean; follow_up: unknown }> = {}) => ({
    id,
    auto_reply_channel_ids: [] as string[],
    is_default: false,
    sole_active: false,
    follow_up: comLembretes as unknown,
    ...extra,
  })

  it('cobertura: dono, lista de canais, padrão — igual ao filtro da varredura', () => {
    expect(agenteCobreAConversa(agente('a-1'), { aiAgentId: 'a-1', channelId: 'ch-1' })).toBe(true)
    expect(agenteCobreAConversa(agente('a-1', { is_default: true }), { aiAgentId: 'a-2', channelId: 'ch-1' })).toBe(false)
    expect(
      agenteCobreAConversa(agente('a-1', { auto_reply_channel_ids: ['ch-1'] }), { aiAgentId: null, channelId: 'ch-1' }),
    ).toBe(true)
    expect(
      agenteCobreAConversa(agente('a-1', { auto_reply_channel_ids: ['ch-1'] }), { aiAgentId: null, channelId: 'ch-2' }),
    ).toBe(false)
    expect(agenteCobreAConversa(agente('a-1', { is_default: true }), { aiAgentId: null, channelId: 'ch-9' })).toBe(true)
    expect(agenteCobreAConversa(agente('a-1', { sole_active: true }), { aiAgentId: null, channelId: null })).toBe(true)
    // Especialista catch-all só pega conversa transferida para ele.
    expect(agenteCobreAConversa(agente('a-1'), { aiAgentId: null, channelId: 'ch-1' })).toBe(false)
  })

  it('o dono da conversa vem antes do padrão', () => {
    const escolhido = escolherAgenteDosLembretes(
      [agente('a-padrao', { is_default: true }), agente('a-dono')],
      { aiAgentId: 'a-dono', channelId: 'ch-1' },
    )
    expect(escolhido?.id).toBe('a-dono')
  })

  it('quem tem o canal na lista vem antes do padrão', () => {
    const escolhido = escolherAgenteDosLembretes(
      [agente('a-padrao', { is_default: true }), agente('a-canal', { auto_reply_channel_ids: ['ch-1'] })],
      { aiAgentId: null, channelId: 'ch-1' },
    )
    expect(escolhido?.id).toBe('a-canal')
  })

  it('agente sem lembretes de consulta não responde por eles', () => {
    const escolhido = escolherAgenteDosLembretes(
      [agente('a-1', { is_default: true, follow_up: { enabled: true, meetingReminders: [] } })],
      { aiAgentId: null, channelId: 'ch-1' },
    )
    expect(escolhido).toBeNull()
  })

  it('ninguém cobre a conversa: null (nenhum lembrete sairia por ela)', () => {
    expect(escolherAgenteDosLembretes([agente('a-1')], { aiAgentId: null, channelId: 'ch-1' })).toBeNull()
  })
})

describe('lembretesDoCompromisso: a conversa e o agente que a varredura usaria', () => {
  const dialect = new PgDialect()
  const texto = (i: number) => dialect.sqlToQuery(h.execute.mock.calls[i]?.[0] as SQL)

  beforeEach(() => {
    h.execute.mockReset()
  })

  it('conversa resolvida como na varredura (negócio ligado, senão a mais recente) e o agente que a cobre', async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [{ ai_agent_id: null, channel_id: 'ch-1' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'a-1',
            account_id: 'conta-0001',
            auto_reply_channel_ids: [],
            is_default: true,
            sole_active: false,
            follow_up: { enabled: true, meetingReminders: [{ when: 'before', offsetValue: 24, offsetUnit: 'hours' }] },
          },
        ],
      })

    const degraus = await lembretesDoCompromisso('conta-0001', 'evt-0001')

    expect(degraus).toHaveLength(1)
    const conv = texto(0)
    expect(conv.sql).toContain('COALESCE')
    expect(conv.sql).toContain('ORDER BY cv2.last_message_at DESC NULLS LAST')
    expect(conv.params).toEqual(['evt-0001', 'conta-0001'])
    // Os mesmos agentes da varredura (ativos, follow-up ligado), só desta conta.
    const agentes = texto(1)
    expect(agentes.sql).toContain("follow_up->>'enabled' = 'true'")
    expect(agentes.params).toEqual(['conta-0001'])
    // Interpolação depois de "--" derruba a consulta (incidente do lembrete).
    expect(conv.sql + agentes.sql).not.toContain('--')
  })

  it('compromisso sem conversa nenhuma: [] e nem procura agente', async () => {
    h.execute.mockResolvedValueOnce({ rows: [] })

    expect(await lembretesDoCompromisso('conta-0001', 'evt-0001')).toEqual([])
    expect(h.execute).toHaveBeenCalledTimes(1)
  })
})
