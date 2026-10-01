import { describe, expect, it } from 'vitest'

import {
  decidirConfirmacao,
  fraseDaConsulta,
  profissionalDaAgenda,
  quandoDaConsulta,
  textoDaConfirmacao,
  tipoDaConfirmacaoNaEdicao,
} from './confirmacao-agendamento'

// 01/10 — confirmação ao paciente na hora de agendar (pedido de uma clínica).
// Nomes fictícios (LGPD): nenhum paciente nem profissional de verdade aqui.

const SP = 'America/Sao_Paulo'
// 08/10/2026 é uma quinta-feira. 17:00Z = 14:00 em São Paulo (UTC-3).
const QUI_14H = '2026-10-08T17:00:00.000Z'
const AGORA = new Date('2026-10-01T15:00:00.000Z')

describe('quando a edição pede confirmação', () => {
  const antes = { startsAt: '2026-10-08 17:00:00+00', calendarId: 'cal-a', contactId: 'c-1' }

  it('mudou só título/descrição (mesmo instante, escrito de outro jeito): nada', () => {
    expect(tipoDaConfirmacaoNaEdicao({ antes, depois: { ...antes, startsAt: QUI_14H } })).toBeNull()
  })

  it('mudou dia/hora: remarcação', () => {
    expect(
      tipoDaConfirmacaoNaEdicao({ antes, depois: { ...antes, startsAt: '2026-10-09T17:00:00.000Z' } }),
    ).toBe('remarcacao')
  })

  it('mudou a agenda (o profissional): remarcação', () => {
    expect(tipoDaConfirmacaoNaEdicao({ antes, depois: { ...antes, calendarId: 'cal-b' } })).toBe('remarcacao')
  })

  it('ligou o paciente agora: para ele é marcação', () => {
    expect(
      tipoDaConfirmacaoNaEdicao({ antes: { ...antes, contactId: null }, depois: antes }),
    ).toBe('marcacao')
  })

  it('trocou de paciente (mesmo com outro horário): marcação para o novo', () => {
    expect(
      tipoDaConfirmacaoNaEdicao({
        antes,
        depois: { ...antes, contactId: 'c-2', startsAt: '2026-10-09T17:00:00.000Z' },
      }),
    ).toBe('marcacao')
  })

  it('tirou o paciente: nada', () => {
    expect(
      tipoDaConfirmacaoNaEdicao({ antes, depois: { ...antes, contactId: null, startsAt: QUI_14H } }),
    ).toBeNull()
  })
})

describe('se o compromisso pode receber a confirmação', () => {
  const evento = {
    status: 'confirmed',
    startsAt: QUI_14H,
    endsAt: '2026-10-08T18:00:00.000Z',
    allDay: false,
    contactId: 'c-1',
  }
  const contato = { isGroup: false, optedOut: false }

  it('consulta futura com paciente: envia', () => {
    expect(decidirConfirmacao({ evento, contato, agora: AGORA })).toEqual({ envia: true })
  })

  it('sem paciente: não envia', () => {
    const d = decidirConfirmacao({ evento: { ...evento, contactId: null }, contato: null, agora: AGORA })
    expect(d).toEqual({ envia: false, motivo: 'o compromisso não tem paciente ligado' })
  })

  it('cancelado: não envia', () => {
    const d = decidirConfirmacao({ evento: { ...evento, status: 'cancelled' }, contato, agora: AGORA })
    expect(d.envia).toBe(false)
  })

  it('no passado (ou começando agora): não envia', () => {
    expect(decidirConfirmacao({ evento, contato, agora: new Date(QUI_14H) }).envia).toBe(false)
    expect(
      decidirConfirmacao({ evento, contato, agora: new Date('2026-10-09T12:00:00.000Z') }),
    ).toEqual({ envia: false, motivo: 'o horário do compromisso já passou' })
  })

  it('dia inteiro de HOJE ainda vale até o fim do dia', () => {
    const hoje = {
      ...evento,
      allDay: true,
      startsAt: '2026-10-08T03:00:00.000Z',
      endsAt: '2026-10-09T02:59:00.000Z',
    }
    expect(decidirConfirmacao({ evento: hoje, contato, agora: new Date('2026-10-08T15:00:00.000Z') })).toEqual({
      envia: true,
    })
  })

  it('contato de grupo: não envia', () => {
    const d = decidirConfirmacao({ evento, contato: { ...contato, isGroup: true }, agora: AGORA })
    expect(d.envia).toBe(false)
  })

  it('pediu para não receber mensagens (opt-out): não envia, e diz por quê', () => {
    const d = decidirConfirmacao({ evento, contato: { ...contato, optedOut: true }, agora: AGORA })
    expect(d).toEqual({
      envia: false,
      motivo: 'o paciente pediu para não receber mensagens (não perturbe)',
    })
  })
})

describe('o nome da agenda vira "com {profissional}"?', () => {
  it('nome de profissional: vai como está (espaços arrumados)', () => {
    expect(profissionalDaAgenda('Dra. Fulana  Exemplo')).toBe('Dra. Fulana Exemplo')
    expect(profissionalDaAgenda('Beltrano Teste')).toBe('Beltrano Teste')
  })

  it('"Agenda do/da/-" na frente: fica só o nome', () => {
    expect(profissionalDaAgenda('Agenda do Dr. Exemplo')).toBe('Dr. Exemplo')
    expect(profissionalDaAgenda('Agenda - Fulana')).toBe('Fulana')
    expect(profissionalDaAgenda('Agenda Dr. Exemplo')).toBe('Dr. Exemplo')
  })

  it('genérico (e-mail, Minha agenda, Google, vazio, sala/serviço): sem profissional', () => {
    for (const nome of [
      'clinica.exemplo@gmail.com',
      'Minha agenda',
      'Agenda',
      'Agenda geral',
      'Google',
      'Calendário',
      '',
      '   ',
      null,
      'Radiologia',
      'Sala 2',
      'Avaliação',
      'Feriados no Brasil',
      '12345',
    ]) {
      expect(profissionalDaAgenda(nome)).toBeNull()
    }
  })
})

describe('quando é a consulta (no fuso da conta)', () => {
  it('hora cheia: "às 14h"', () => {
    expect(quandoDaConsulta({ startsAt: QUI_14H, allDay: false, tz: SP })).toBe(
      'quinta-feira, 08/10/2026, às 14h',
    )
  })

  it('com minutos e hora de um dígito: "às 9h05"', () => {
    expect(quandoDaConsulta({ startsAt: '2026-10-08T12:05:00.000Z', allDay: false, tz: SP })).toBe(
      'quinta-feira, 08/10/2026, às 9h05',
    )
  })

  it('o DIA é o do fuso, não o do UTC: 02:30Z do dia 09 ainda é dia 08 em São Paulo', () => {
    expect(quandoDaConsulta({ startsAt: '2026-10-09T02:30:00.000Z', allDay: false, tz: SP })).toBe(
      'quinta-feira, 08/10/2026, às 23h30',
    )
  })

  it('fuso da conta manda: o mesmo instante em Manaus é 13h', () => {
    expect(quandoDaConsulta({ startsAt: QUI_14H, allDay: false, tz: 'America/Manaus' })).toBe(
      'quinta-feira, 08/10/2026, às 13h',
    )
  })

  it('fuso inválido gravado na conta: cai em São Paulo, não quebra', () => {
    expect(quandoDaConsulta({ startsAt: QUI_14H, allDay: false, tz: 'Fuso/Inexistente' })).toBe(
      'quinta-feira, 08/10/2026, às 14h',
    )
  })

  it('dia inteiro: sem hora, e o dia certo mesmo gravado à meia-noite UTC', () => {
    // Meia-noite de São Paulo (como o import do Google grava)…
    expect(quandoDaConsulta({ startsAt: '2026-10-08T03:00:00.000Z', allDay: true, tz: SP })).toBe(
      'quinta-feira, 08/10/2026',
    )
    // …e meia-noite de um navegador em UTC (lida às 21h do dia ANTERIOR em SP).
    expect(quandoDaConsulta({ startsAt: '2026-10-08T00:00:00.000Z', allDay: true, tz: SP })).toBe(
      'quinta-feira, 08/10/2026',
    )
  })
})

describe('o texto que o paciente recebe', () => {
  const base = { nomeContato: 'Maria Exemplo', nomeAgenda: 'Dr. Exemplo', startsAt: QUI_14H, allDay: false, tz: SP }

  it('marcação', () => {
    expect(textoDaConfirmacao({ ...base, tipo: 'marcacao' })).toBe(
      'Olá, Maria! Sua consulta com Dr. Exemplo está confirmada para quinta-feira, 08/10/2026, às 14h. Qualquer dúvida, é só responder por aqui.',
    )
  })

  it('remarcação', () => {
    expect(textoDaConfirmacao({ ...base, tipo: 'remarcacao' })).toBe(
      'Olá, Maria! Sua consulta com Dr. Exemplo foi remarcada para quinta-feira, 08/10/2026, às 14h. Qualquer dúvida, é só responder por aqui.',
    )
  })

  it('dia inteiro: sem "às"', () => {
    expect(
      textoDaConfirmacao({ ...base, tipo: 'marcacao', startsAt: '2026-10-08T03:00:00.000Z', allDay: true }),
    ).toBe(
      'Olá, Maria! Sua consulta com Dr. Exemplo está confirmada para quinta-feira, 08/10/2026. Qualquer dúvida, é só responder por aqui.',
    )
  })

  it('agenda genérica: tira o "com {profissional}"', () => {
    expect(textoDaConfirmacao({ ...base, tipo: 'marcacao', nomeAgenda: 'clinica.exemplo@gmail.com' })).toBe(
      'Olá, Maria! Sua consulta está confirmada para quinta-feira, 08/10/2026, às 14h. Qualquer dúvida, é só responder por aqui.',
    )
  })

  it('nome que não parece de gente vira "Olá!"', () => {
    for (const nomeContato of ['💎💎', '+55 11 90000-0000', 'Loja do Exemplo', '', null]) {
      expect(textoDaConfirmacao({ ...base, tipo: 'marcacao', nomeContato })).toMatch(/^Olá! Sua consulta/)
    }
  })

  it('título vem junto com o nome ("Sra. Ana"), nunca sozinho', () => {
    expect(textoDaConfirmacao({ ...base, tipo: 'marcacao', nomeContato: 'Sra. ANA EXEMPLO' })).toMatch(
      /^Olá, Sra\. Ana! /,
    )
  })

  it('sem travessão em nenhum caso', () => {
    for (const tipo of ['marcacao', 'remarcacao'] as const) {
      for (const allDay of [false, true]) {
        expect(textoDaConfirmacao({ ...base, tipo, allDay })).not.toMatch(/[—–]/)
      }
    }
  })

  it('a prévia do modal é o miolo da mesma mensagem', () => {
    const frase = fraseDaConsulta({ ...base, tipo: 'marcacao' })
    expect(textoDaConfirmacao({ ...base, tipo: 'marcacao' })).toContain(frase)
  })
})
