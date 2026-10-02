import { describe, expect, it } from 'vitest'

import {
  avisoDeHorarioOcupado,
  chaveDoHorario,
  chaveParaConferir,
  conflitosNoHorario,
  horarioTravaOSalvar,
  pedidoDaChave,
  situacaoDoHorario,
  type CompromissoNoHorario,
} from './horario-ocupado'

// 02/10 — a mesma consulta lançada duas vezes na mesma agenda: uma direto no
// Google (sem paciente) e outra pelo CRM. Ids e títulos fictícios.

const SP = 'America/Sao_Paulo'
// 05/10/2026, 14h–15h em São Paulo (UTC-3).
const PEDIDO = { calendarId: 'cal-a', startsAt: '2026-10-05T17:00:00.000Z', endsAt: '2026-10-05T18:00:00.000Z' }

const c = (o: Partial<CompromissoNoHorario>): CompromissoNoHorario => ({
  id: 'ev-x',
  calendarId: 'cal-a',
  title: 'Consulta',
  startsAt: '2026-10-05T17:30:00.000Z',
  endsAt: '2026-10-05T18:30:00.000Z',
  allDay: false,
  status: 'confirmed',
  busy: true,
  ...o,
})

describe('quem ocupa o horário', () => {
  it('mesma agenda, de pé, ocupando e cruzando: entra', () => {
    expect(conflitosNoHorario(PEDIDO, [c({})]).map((x) => x.id)).toEqual(['ev-x'])
  })

  it('cruzar por qualquer lado, ou cobrir o horário inteiro, conta', () => {
    const linhas = [
      c({ id: 'antes', startsAt: '2026-10-05T16:30:00.000Z', endsAt: '2026-10-05T17:15:00.000Z' }),
      c({ id: 'dentro', startsAt: '2026-10-05T17:15:00.000Z', endsAt: '2026-10-05T17:45:00.000Z' }),
      c({ id: 'cobre', startsAt: '2026-10-05T12:00:00.000Z', endsAt: '2026-10-05T22:00:00.000Z' }),
    ]
    expect(conflitosNoHorario(PEDIDO, linhas).map((x) => x.id)).toEqual(['cobre', 'antes', 'dentro'])
  })

  it('encostar não é cruzar (14h–15h e 15h–16h estão uma depois da outra)', () => {
    const linhas = [
      c({ id: 'depois', startsAt: '2026-10-05T18:00:00.000Z', endsAt: '2026-10-05T19:00:00.000Z' }),
      c({ id: 'antes', startsAt: '2026-10-05T16:00:00.000Z', endsAt: '2026-10-05T17:00:00.000Z' }),
    ]
    expect(conflitosNoHorario(PEDIDO, linhas)).toEqual([])
  })

  it('outra agenda, desmarcado, "Disponível" e o próprio compromisso: fora', () => {
    const linhas = [
      c({ id: 'outra', calendarId: 'cal-b' }),
      c({ id: 'desmarcado', status: 'cancelled' }),
      c({ id: 'livre', busy: false }),
      c({ id: 'eu' }),
    ]
    expect(conflitosNoHorario({ ...PEDIDO, ignorarId: 'eu' }, linhas)).toEqual([])
  })

  it('sem paciente ligado, tanto faz — o caso real não tinha', () => {
    // A linha nem tem campo de paciente: a regra é só agenda + horário.
    expect(conflitosNoHorario(PEDIDO, [c({ title: 'Consulta Ana (lançada no Google)' })])).toHaveLength(1)
  })

  it('fim antes do início: confere como o salvar grava (início + 1h)', () => {
    expect(
      conflitosNoHorario({ ...PEDIDO, endsAt: '2026-10-05T16:00:00.000Z' }, [c({})]).map((x) => x.id),
    ).toEqual(['ev-x'])
  })

  it('data ilegível ou sem agenda: nada', () => {
    expect(conflitosNoHorario({ ...PEDIDO, startsAt: 'x' }, [c({})])).toEqual([])
    expect(conflitosNoHorario({ ...PEDIDO, calendarId: '' }, [c({})])).toEqual([])
  })
})

describe('a frase do aviso (no fuso da conta)', () => {
  it('"Já há \'<título>\' das HH:MM às HH:MM nesta agenda."', () => {
    expect(avisoDeHorarioOcupado(c({}), SP)).toBe("Já há 'Consulta' das 14:30 às 15:30 nesta agenda.")
  })

  it('atravessando a meia-noite, com o dia; dia inteiro, "o dia todo"; sem título, "sem título"', () => {
    expect(
      avisoDeHorarioOcupado(c({ startsAt: '2026-10-06T01:00:00.000Z', endsAt: '2026-10-06T05:00:00.000Z' }), SP),
    ).toBe("Já há 'Consulta' das 22:00 de 05/10 às 02:00 de 06/10 nesta agenda.")
    expect(avisoDeHorarioOcupado(c({ allDay: true, title: 'Curso' }), SP)).toBe("Já há 'Curso' o dia todo nesta agenda.")
    expect(avisoDeHorarioOcupado(c({ title: '  ' }), SP)).toBe("Já há 'sem título' das 14:30 às 15:30 nesta agenda.")
  })

  it('fuso inválido gravado na conta: cai em São Paulo, não quebra', () => {
    expect(avisoDeHorarioOcupado(c({}), 'Fuso/Inexistente')).toBe("Já há 'Consulta' das 14:30 às 15:30 nesta agenda.")
  })
})

describe('o modal: quando confere e quando o Salvar espera', () => {
  const ISO = { startsAt: PEDIDO.startsAt, endsAt: PEDIDO.endsAt }
  const CHAVE = chaveDoHorario(PEDIDO) as string

  it('a chave vai e volta', () => {
    expect(pedidoDaChave(CHAVE)).toEqual(PEDIDO)
    expect(pedidoDaChave('lixo')).toBeNull()
  })

  it('compromisso novo com agenda e horário: confere', () => {
    expect(chaveParaConferir({ id: null, status: 'confirmed', calendarId: 'cal-a', iso: ISO, aberto: null })).toBe(CHAVE)
  })

  it('sem agenda, data inválida ou desmarcado: não confere', () => {
    expect(chaveParaConferir({ id: null, status: 'confirmed', calendarId: '', iso: ISO, aberto: null })).toBeNull()
    expect(chaveParaConferir({ id: null, status: 'confirmed', calendarId: 'cal-a', iso: null, aberto: null })).toBeNull()
    expect(chaveParaConferir({ id: 'ev-1', status: 'cancelled', calendarId: 'cal-a', iso: ISO, aberto: null })).toBeNull()
  })

  it('edição: só quando mudou a agenda ou o horário (corrigir o título não pergunta nada)', () => {
    const base = { id: 'ev-1', status: 'confirmed', calendarId: 'cal-a', iso: ISO, aberto: CHAVE }
    expect(chaveParaConferir(base)).toBeNull()
    expect(chaveParaConferir({ ...base, calendarId: 'cal-b' })).toBe(chaveDoHorario({ ...PEDIDO, calendarId: 'cal-b' }))
    expect(
      chaveParaConferir({ ...base, iso: { ...ISO, endsAt: '2026-10-05T18:30:00.000Z' } }),
    ).not.toBeNull()
  })

  const OCUPA = { id: 'ev-google', title: 'Consulta', startsAt: ISO.startsAt, endsAt: ISO.endsAt, allDay: false }

  it('esperando a resposta desta chave: conferindo — o Salvar espera', () => {
    const s = situacaoDoHorario({ chave: CHAVE, conferencia: null, confirmadoPara: null })
    expect(s).toEqual({ tipo: 'conferindo' })
    expect(horarioTravaOSalvar(s)).toBe(true)
    // Resposta de OUTRA chave (horário antigo) não vale para este.
    expect(
      situacaoDoHorario({ chave: CHAVE, conferencia: { chave: 'cal-a|outra|chave', conflitos: [] }, confirmadoPara: null }),
    ).toEqual({ tipo: 'conferindo' })
  })

  it('ocupado: o Salvar espera o "Salvar mesmo assim" DESTE horário', () => {
    const conferencia = { chave: CHAVE, conflitos: [OCUPA] }
    const s = situacaoDoHorario({ chave: CHAVE, conferencia, confirmadoPara: null })
    expect(s).toEqual({ tipo: 'ocupado', conflitos: [OCUPA], confirmado: false })
    expect(horarioTravaOSalvar(s)).toBe(true)

    const confirmado = situacaoDoHorario({ chave: CHAVE, conferencia, confirmadoPara: CHAVE })
    expect(horarioTravaOSalvar(confirmado)).toBe(false)
    // Confirmou outro horário e mudou: pede de novo.
    expect(horarioTravaOSalvar(situacaoDoHorario({ chave: CHAVE, conferencia, confirmadoPara: 'cal-a|x|y' }))).toBe(true)
  })

  it('livre, nada a conferir, ou a busca falhou: não trava (não bloquear é a regra)', () => {
    for (const s of [
      situacaoDoHorario({ chave: CHAVE, conferencia: { chave: CHAVE, conflitos: [] }, confirmadoPara: null }),
      situacaoDoHorario({ chave: null, conferencia: null, confirmadoPara: null }),
      situacaoDoHorario({ chave: CHAVE, conferencia: { chave: CHAVE, conflitos: null }, confirmadoPara: null }),
    ]) {
      expect(horarioTravaOSalvar(s), s.tipo).toBe(false)
    }
    expect(
      situacaoDoHorario({ chave: CHAVE, conferencia: { chave: CHAVE, conflitos: null }, confirmadoPara: null }).tipo,
    ).toBe('naoConferido')
  })

  it('remarcação: a consulta X que este salvar move não ocupa o horário novo', () => {
    const s = situacaoDoHorario({
      chave: CHAVE,
      conferencia: { chave: CHAVE, conflitos: [OCUPA] },
      confirmadoPara: null,
      ignorar: ['ev-google', null],
    })
    expect(s).toEqual({ tipo: 'livre' })
  })
})
