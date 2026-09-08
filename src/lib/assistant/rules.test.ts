import { describe, expect, it } from 'vitest'

import {
  formatAgenda,
  formatStalledDeals,
  formatTeam,
  looksLikeAssistantRequest,
  normalizeIntent,
  parseTime,
  parseWhenDate,
  tzOffsetMinutes,
  zonedIso,
} from './rules'

const hoje = new Date(2026, 8, 8) // terça, 08/09/2026

describe('assistente do dono — filtro barato', () => {
  it('reconhece pedidos pro CRM e ignora conversa comum', () => {
    expect(looksLikeAssistantRequest('o que tem parado no funil?')).toBe(true)
    expect(looksLikeAssistantRequest('me lembra sexta de ligar pro Carlos')).toBe(true)
    expect(looksLikeAssistantRequest('passa o João Silva pro Vitor')).toBe(true)
    expect(looksLikeAssistantRequest('marca reunião com a Ana amanhã às 15h')).toBe(true)
    expect(looksLikeAssistantRequest('quem está esperando resposta?')).toBe(true)
    expect(looksLikeAssistantRequest('Bom dia')).toBe(false)
    expect(looksLikeAssistantRequest('ok')).toBe(false)
  })
})

describe('assistente do dono — JSON do modelo', () => {
  it('normaliza e recusa kind desconhecido', () => {
    expect(normalizeIntent({ kind: 'create_task', title: 'Ligar pro Carlos', when: 'sexta', time: '9h', customer: 'null' })).toEqual({
      kind: 'create_task',
      customer: null,
      assignee: null,
      title: 'Ligar pro Carlos',
      when: 'sexta',
      time: '09:00',
      duration: null,
    })
    expect(normalizeIntent({ kind: 'dançar' })).toBeNull()
    expect(normalizeIntent('x')).toBeNull()
  })
})

describe('assistente do dono — quando', () => {
  it('hoje, amanhã, dia da semana (próxima ocorrência), data, +N', () => {
    expect(parseWhenDate('hoje', hoje)).toBe('2026-09-08')
    expect(parseWhenDate('amanhã', hoje)).toBe('2026-09-09')
    expect(parseWhenDate('sexta', hoje)).toBe('2026-09-11')
    expect(parseWhenDate('terça', hoje)).toBe('2026-09-08') // hoje é terça
    expect(parseWhenDate('próxima terça', hoje)).toBe('2026-09-15')
    expect(parseWhenDate('10/09', hoje)).toBe('2026-09-10')
    expect(parseWhenDate('+2', hoje)).toBe('2026-09-10')
    expect(parseWhenDate('', hoje)).toBeNull()
  })
  it('hora em vários jeitos', () => {
    expect(parseTime('14h')).toBe('14:00')
    expect(parseTime('14:30')).toBe('14:30')
    expect(parseTime('às 9')).toBe('09:00')
    expect(parseTime('3 da tarde')).toBe('15:00')
    expect(parseTime('')).toBeNull()
  })
  it('fuso da conta vira ISO certo (Campo Grande = -04:00 em setembro)', () => {
    expect(tzOffsetMinutes('America/Campo_Grande', new Date(Date.UTC(2026, 8, 8, 12)))).toBe(-240)
    expect(zonedIso('2026-09-09', '15:00', 'America/Campo_Grande')).toBe('2026-09-09T19:00:00.000Z')
    expect(zonedIso('2026-09-09', '15:00', 'America/Sao_Paulo')).toBe('2026-09-09T18:00:00.000Z')
  })
})

describe('assistente do dono — textos', () => {
  it('funil parado lista com valor, etapa e dias; vazio elogia', () => {
    const t = formatStalledDeals(
      [{ title: 'Site', contact: 'Ana', stage: 'Proposta', value: 1500, currency: 'BRL', days: 12, assignee: null }],
      1,
      7,
    ).replace(/ /g, ' ')
    expect(t).toContain('1 negócio parado há mais de 7 dias')
    expect(t).toContain('Ana — R$ 1.500,00 · Proposta · 12d parado · sem responsável')
    expect(formatStalledDeals([], 0, 7)).toContain('Nada parado')
  })
  it('agenda e equipe', () => {
    const a = formatAgenda([{ title: 'Reunião', startsAt: '2026-09-09T19:00:00.000Z', endsAt: '2026-09-09T20:00:00.000Z', allDay: false, contact: 'Ana' }], 'America/Campo_Grande', 'de amanhã')
    expect(a).toContain('Agenda de amanhã:')
    expect(a).toMatch(/09\/09 15:00 — Reunião · Ana/)
    const e = formatTeam({ members: [{ name: 'Vitor', openConversations: 3, sentToday: 12 }], waiting: [] })
    expect(e).toContain('Vitor — 12 mensagens enviadas · 3 conversas abertas')
    expect(e).toContain('Ninguém esperando')
  })
})
