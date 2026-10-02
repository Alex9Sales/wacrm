import { describe, expect, it } from 'vitest'

import {
  aindaVaiAcontecer,
  pessoasDoTitulo,
  podeRemarcar,
  rotuloDaRemarcacao,
  sugerirRemarcacao,
} from './remarcacao'

// 02/10 — "remarcação ou consulta nova?" no modal da Agenda. Família no mesmo
// contato: a mãe (Rosana) marca o filho (Davi) e a filha (Bianca).
// Nomes fictícios (LGPD): nenhum paciente nem profissional de verdade aqui.

const AGENDAS = ['Dra. Helena Prado', 'Dra. Marta Lins', 'Radiologia', 'Minha agenda']
const SP = 'America/Sao_Paulo'
// 13/10/2026 é uma terça-feira. 12:30Z = 9h30 em São Paulo (UTC-3).
const TER_9H30 = '2026-10-13T12:30:00.000Z'
const AGORA = new Date('2026-10-02T15:00:00.000Z')

const DO_DAVI = { id: 'ev-davi', title: 'Avaliação Dra. Helena · Davi Moura' }
const DA_BIANCA = { id: 'ev-bianca', title: 'Avaliação · Bianca Moura' }

describe('quem o título nomeia', () => {
  it('tira o tipo da consulta e o profissional (até a pontuação)', () => {
    expect(pessoasDoTitulo('Avaliação Dra. Helena · Davi Moura', [])).toEqual([['davi', 'moura']])
    expect(pessoasDoTitulo('Avaliação Drª Marta - Davi', [])).toEqual([['davi']])
    expect(pessoasDoTitulo('Retorno do Davi', [])).toEqual([['davi']])
  })

  it('tira palavra de nome de agenda', () => {
    expect(pessoasDoTitulo('Helena', AGENDAS)).toEqual([])
    expect(pessoasDoTitulo('Radiologia Davi', AGENDAS)).toEqual([['davi']])
  })

  it('separa pessoas por "e", vírgula, parênteses, barra', () => {
    expect(pessoasDoTitulo('Rosana (Davi e Bianca)', AGENDAS)).toEqual([['rosana'], ['davi'], ['bianca']])
    expect(pessoasDoTitulo('Davi, Bianca', AGENDAS)).toEqual([['davi'], ['bianca']])
    expect(pessoasDoTitulo('Davi / Bianca', AGENDAS)).toEqual([['davi'], ['bianca']])
  })

  it('"e" ligando procedimentos não vira outra pessoa; "é" não separa', () => {
    expect(pessoasDoTitulo('Avaliação e limpeza · Davi', AGENDAS)).toEqual([['davi']])
    expect(pessoasDoTitulo('Davi é retorno', AGENDAS)).toEqual([['davi']])
  })

  it('sem acento e sem caixa', () => {
    expect(pessoasDoTitulo('RETORNO LÍVIA', AGENDAS)).toEqual([['livia']])
  })
})

describe('a sugestão: remarcação de qual, ou consulta nova', () => {
  it('o mesmo nome do título de uma consulta → remarcação dela', () => {
    expect(sugerirRemarcacao('Davi', [DO_DAVI], AGENDAS)).toBe('ev-davi')
    expect(sugerirRemarcacao('Retorno · Davi', [DO_DAVI, DA_BIANCA], AGENDAS)).toBe('ev-davi')
  })

  it('outro paciente da família → nova', () => {
    expect(sugerirRemarcacao('Bianca', [DO_DAVI], AGENDAS)).toBeNull()
  })

  it('só o sobrenome em comum (irmãos) não é a mesma pessoa', () => {
    expect(sugerirRemarcacao('Bianca Moura', [DO_DAVI], AGENDAS)).toBeNull()
  })

  it('o nome do contato da família (mais de uma pessoa) → nova, mesmo casando com uma só', () => {
    expect(sugerirRemarcacao('Rosana (Davi e Bianca)', [DO_DAVI, DA_BIANCA], AGENDAS)).toBeNull()
    expect(sugerirRemarcacao('Rosana (Davi e Bianca)', [DO_DAVI], AGENDAS)).toBeNull()
  })

  it('casou com mais de uma consulta → nova', () => {
    const duas = [
      { id: 'ev-1', title: 'Avaliação · Davi' },
      { id: 'ev-2', title: 'Retorno · Davi' },
    ]
    expect(sugerirRemarcacao('Davi', duas, AGENDAS)).toBeNull()
  })

  it('título novo sem nome ("Avaliação", em branco) → nova', () => {
    expect(sugerirRemarcacao('Avaliação', [DO_DAVI], AGENDAS)).toBeNull()
    expect(sugerirRemarcacao('', [DO_DAVI], AGENDAS)).toBeNull()
  })

  it('consulta antiga com o nome da família inteira não serve de pista', () => {
    expect(sugerirRemarcacao('Davi', [{ id: 'ev-fam', title: 'Rosana (Davi e Bianca)' }], AGENDAS)).toBeNull()
  })

  it('paciente com o nome de uma profissional: na dúvida, nova', () => {
    expect(sugerirRemarcacao('Marta', [{ id: 'ev-m', title: 'Avaliação · Marta Reis' }], AGENDAS)).toBeNull()
  })

  it('sem consultas → nova', () => {
    expect(sugerirRemarcacao('Davi', [], AGENDAS)).toBeNull()
  })
})

describe('a consulta escolhida ainda pode ser remarcada (o servidor confere)', () => {
  const ALVO = { status: 'confirmed', contactId: 'c-1', startsAt: TER_9H30, endsAt: '2026-10-13T13:30:00.000Z', allDay: false }

  it('do mesmo paciente, de pé e futura: pode', () => {
    expect(podeRemarcar(ALVO, 'c-1', AGORA)).toBe(true)
  })

  it('de outro paciente, cancelada, passada, de outra conta ou sem paciente no formulário: não', () => {
    expect(podeRemarcar(ALVO, 'c-2', AGORA)).toBe(false)
    expect(podeRemarcar({ ...ALVO, status: 'cancelled' }, 'c-1', AGORA)).toBe(false)
    expect(podeRemarcar(ALVO, 'c-1', new Date('2026-10-13T12:31:00.000Z'))).toBe(false)
    expect(podeRemarcar(null, 'c-1', AGORA)).toBe(false)
    expect(podeRemarcar(ALVO, null, AGORA)).toBe(false)
  })

  it('dia inteiro vale até o fim do dia', () => {
    const diaTodo = { startsAt: '2026-10-13T03:00:00.000Z', endsAt: '2026-10-14T02:59:00.000Z', allDay: true }
    expect(aindaVaiAcontecer(diaTodo, new Date('2026-10-13T20:00:00.000Z'))).toBe(true)
    expect(aindaVaiAcontecer(diaTodo, new Date('2026-10-14T03:00:00.000Z'))).toBe(false)
  })
})

describe('o texto da opção', () => {
  it('dia e hora no fuso da conta, com a agenda e o título', () => {
    expect(
      rotuloDaRemarcacao(
        { startsAt: TER_9H30, allDay: false, calendarName: 'Dra. Helena Prado', title: 'Avaliação · Davi Moura' },
        SP,
      ),
    ).toBe(
      'Remarcação da consulta de terça-feira, 13/10/2026, às 9h30 com Dra. Helena Prado (Avaliação · Davi Moura) — a antiga deixa de valer',
    )
  })

  it('sem nome de agenda: sem o "com"', () => {
    expect(rotuloDaRemarcacao({ startsAt: TER_9H30, allDay: false, calendarName: null, title: 'Davi' }, SP)).toBe(
      'Remarcação da consulta de terça-feira, 13/10/2026, às 9h30 (Davi) — a antiga deixa de valer',
    )
  })
})
