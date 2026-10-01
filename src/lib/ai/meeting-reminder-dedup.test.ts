import { describe, expect, it } from 'vitest'
import {
  chaveDoDegrau,
  decidirLembreteDuplicado,
  duplicadosDe,
  escolherCanonico,
  type CompromissoDoLembrete,
} from './meeting-reminder-dedup'

/**
 * 01/10: a recepção lança a mesma consulta na agenda da dona e na do
 * profissional. O paciente tem que receber UM lembrete por degrau, não dois.
 * Ids e horários fictícios.
 */
const CONTA = 'conta-0001'
const PACIENTE = 'contato-ana-teste'
const SABADO_13H = '2026-10-03T16:00:00.000Z'

function compromisso(p: Partial<CompromissoDoLembrete> & { id: string }): CompromissoDoLembrete {
  return {
    accountId: CONTA,
    contactId: PACIENTE,
    startsAt: SABADO_13H,
    status: 'confirmed',
    createdAt: '2026-09-20T12:00:00.000Z',
    remindersSent: 0,
    ...p,
  }
}

// Lançado primeiro (agenda da dona) e lançado depois (agenda do profissional).
const DONA = compromisso({ id: 'evt-b', createdAt: '2026-09-20T12:00:00.000Z' })
const PROFISSIONAL = compromisso({ id: 'evt-a', createdAt: '2026-09-20T12:05:00.000Z' })

describe('o que é duplicado', () => {
  it('mesma conta, mesmo contato, mesmo instante, confirmado e id diferente', () => {
    expect(duplicadosDe(DONA, [PROFISSIONAL]).map((d) => d.id)).toEqual(['evt-a'])
    expect(duplicadosDe(PROFISSIONAL, [DONA]).map((d) => d.id)).toEqual(['evt-b'])
  })

  it('o próprio compromisso não é cópia dele mesmo', () => {
    expect(duplicadosDe(DONA, [DONA])).toEqual([])
  })

  it('horário diferente por segundos NÃO é duplicado', () => {
    const outro = compromisso({ id: 'evt-c', startsAt: '2026-10-03T16:00:01.000Z' })
    expect(duplicadosDe(DONA, [outro])).toEqual([])
    expect(decidirLembreteDuplicado({ evento: outro, outros: [DONA], degrau: 0 }).decisao).toBe(
      'envia',
    )
  })

  it('contato diferente NÃO é duplicado — dois pacientes no mesmo horário', () => {
    const outroPaciente = compromisso({ id: 'evt-c', contactId: 'contato-bruno-teste' })
    expect(duplicadosDe(DONA, [outroPaciente])).toEqual([])
  })

  it('outra conta NÃO é duplicado', () => {
    const outraConta = compromisso({ id: 'evt-c', accountId: 'conta-0002' })
    expect(duplicadosDe(DONA, [outraConta])).toEqual([])
  })

  it('sem contato não se aplica — bloqueio de agenda não é a mesma pessoa', () => {
    const bloqueio1 = compromisso({ id: 'evt-c', contactId: null })
    const bloqueio2 = compromisso({ id: 'evt-d', contactId: null })
    expect(duplicadosDe(bloqueio1, [bloqueio2])).toEqual([])
    expect(decidirLembreteDuplicado({ evento: bloqueio1, outros: [bloqueio2], degrau: 0 })).toEqual(
      { decisao: 'envia', canonicoId: null, duplicados: [] },
    )
  })

  it('cancelado não conta', () => {
    const cancelado = compromisso({ id: 'evt-c', status: 'cancelled' })
    expect(duplicadosDe(DONA, [cancelado])).toEqual([])
  })

  it('o texto do Postgres e o ISO do JSON são o mesmo instante', () => {
    // A linha principal vem como texto do Postgres; as cópias, de dentro de um
    // json_agg. Se a comparação fosse por texto, nenhuma cópia casaria nunca.
    const daLinha = compromisso({ id: 'evt-b', startsAt: '2026-10-03 13:00:00-03' })
    const doJson = compromisso({ id: 'evt-a', startsAt: '2026-10-03T16:00:00+00:00' })
    expect(duplicadosDe(daLinha, [doJson]).map((d) => d.id)).toEqual(['evt-a'])
  })

  it('horário ilegível: na dúvida, cada um segue sozinho como antes', () => {
    const quebrado = compromisso({ id: 'evt-c', startsAt: 'não é data' })
    expect(duplicadosDe(quebrado, [DONA])).toEqual([])
  })
})

describe('quem do grupo envia', () => {
  it('o criado primeiro, olhando de qualquer um dos lados', () => {
    expect(escolherCanonico([DONA, PROFISSIONAL])?.id).toBe('evt-b')
    expect(escolherCanonico([PROFISSIONAL, DONA])?.id).toBe('evt-b')
  })

  it('criados no mesmo instante: o menor id', () => {
    const x = compromisso({ id: 'evt-2', createdAt: '2026-09-20T12:00:00.000Z' })
    const y = compromisso({ id: 'evt-1', createdAt: '2026-09-20 09:00:00-03' })
    expect(escolherCanonico([x, y])?.id).toBe('evt-1')
    expect(escolherCanonico([y, x])?.id).toBe('evt-1')
  })

  it('grupo vazio não tem canônico', () => {
    expect(escolherCanonico([])).toBeNull()
  })
})

describe('par: a mesma consulta em duas agendas', () => {
  it('o canônico envia e a cópia espera — nenhum dos dois manda em dobro', () => {
    expect(decidirLembreteDuplicado({ evento: DONA, outros: [PROFISSIONAL], degrau: 0 })).toEqual({
      decisao: 'envia',
      canonicoId: 'evt-b',
      duplicados: ['evt-a'],
    })
    expect(decidirLembreteDuplicado({ evento: PROFISSIONAL, outros: [DONA], degrau: 0 })).toEqual({
      decisao: 'espera',
      canonicoId: 'evt-b',
      duplicados: ['evt-b'],
    })
  })

  it('depois que o canônico carimba o degrau, a cópia carimba sem enviar', () => {
    const donaJaMandou = { ...DONA, remindersSent: 1 }
    expect(
      decidirLembreteDuplicado({ evento: PROFISSIONAL, outros: [donaJaMandou], degrau: 0 }).decisao,
    ).toBe('carimba')
  })

  it('o degrau seguinte volta a esperar o canônico', () => {
    // A dona mandou o de 24h (reminders_sent = 1); o de 1h ainda não saiu.
    const donaMandouSoOPrimeiro = { ...DONA, remindersSent: 1 }
    const profissionalCarimbado = { ...PROFISSIONAL, remindersSent: 1 }
    expect(
      decidirLembreteDuplicado({
        evento: profissionalCarimbado,
        outros: [donaMandouSoOPrimeiro],
        degrau: 1,
      }).decisao,
    ).toBe('espera')
  })

  it('a cópia nunca envia, mesmo com o canônico travado', () => {
    // Canônico segurado (IA pausada, canal fora) continua com reminders_sent
    // baixo: a cópia não "ajuda" mandando no lugar dele.
    for (const degrau of [0, 1, 2]) {
      expect(
        decidirLembreteDuplicado({ evento: PROFISSIONAL, outros: [DONA], degrau }).decisao,
      ).toBe('espera')
    }
  })

  it('canônico cancelado: a cópia vira canônica e o paciente continua avisado', () => {
    const donaCancelada = { ...DONA, status: 'cancelled' }
    expect(
      decidirLembreteDuplicado({ evento: PROFISSIONAL, outros: [donaCancelada], degrau: 0 }),
    ).toEqual({ decisao: 'envia', canonicoId: null, duplicados: [] })
  })

  it('canônico não repete o degrau que uma cópia já resolveu', () => {
    // Lembrete que saiu pela cópia antes desta regra existir, ou o canônico
    // que voltou de um cancelamento depois que a cópia assumiu.
    const profissionalJaMandou = { ...PROFISSIONAL, remindersSent: 1 }
    expect(
      decidirLembreteDuplicado({ evento: DONA, outros: [profissionalJaMandou], degrau: 0 }).decisao,
    ).toBe('carimba')
    expect(
      decidirLembreteDuplicado({ evento: DONA, outros: [profissionalJaMandou], degrau: 1 }).decisao,
    ).toBe('envia')
  })
})

describe('trio: a mesma consulta em três agendas', () => {
  const PRIMEIRO = compromisso({ id: 'evt-z', createdAt: '2026-09-20T11:00:00.000Z' })
  const SEGUNDO = compromisso({ id: 'evt-y', createdAt: '2026-09-20T12:00:00.000Z' })
  const TERCEIRO = compromisso({ id: 'evt-x', createdAt: '2026-09-20T13:00:00.000Z' })

  it('só o primeiro envia; os outros dois esperam por ELE', () => {
    const decide = (evento: CompromissoDoLembrete, outros: CompromissoDoLembrete[]) =>
      decidirLembreteDuplicado({ evento, outros, degrau: 0 })
    expect(decide(PRIMEIRO, [SEGUNDO, TERCEIRO]).decisao).toBe('envia')
    expect(decide(SEGUNDO, [PRIMEIRO, TERCEIRO])).toMatchObject({
      decisao: 'espera',
      canonicoId: 'evt-z',
    })
    expect(decide(TERCEIRO, [PRIMEIRO, SEGUNDO])).toMatchObject({
      decisao: 'espera',
      canonicoId: 'evt-z',
    })
  })

  it('a cópia espera pelo canônico, não por outra cópia', () => {
    const segundoCarimbado = { ...SEGUNDO, remindersSent: 1 }
    expect(
      decidirLembreteDuplicado({ evento: TERCEIRO, outros: [PRIMEIRO, segundoCarimbado], degrau: 0 })
        .decisao,
    ).toBe('espera')
  })

  it('depois do canônico, as duas cópias carimbam', () => {
    const primeiroMandou = { ...PRIMEIRO, remindersSent: 1 }
    const pares: Array<[CompromissoDoLembrete, CompromissoDoLembrete]> = [
      [SEGUNDO, TERCEIRO],
      [TERCEIRO, SEGUNDO],
    ]
    for (const [evento, outro] of pares) {
      expect(
        decidirLembreteDuplicado({ evento, outros: [primeiroMandou, outro], degrau: 0 }).decisao,
      ).toBe('carimba')
    }
  })

  it('com o primeiro cancelado, o segundo assume e o terceiro espera por ele', () => {
    const primeiroCancelado = { ...PRIMEIRO, status: 'cancelled' }
    expect(
      decidirLembreteDuplicado({ evento: SEGUNDO, outros: [primeiroCancelado, TERCEIRO], degrau: 0 })
        .decisao,
    ).toBe('envia')
    expect(
      decidirLembreteDuplicado({ evento: TERCEIRO, outros: [primeiroCancelado, SEGUNDO], degrau: 0 }),
    ).toMatchObject({ decisao: 'espera', canonicoId: 'evt-y', duplicados: ['evt-y'] })
  })
})

describe('chave do degrau na mesma varredura', () => {
  it('as duas cópias caem na mesma chave, mesmo vindo em formatos diferentes', () => {
    expect(chaveDoDegrau(CONTA, PACIENTE, '2026-10-03 13:00:00-03', 0)).toBe(
      chaveDoDegrau(CONTA, PACIENTE, '2026-10-03T16:00:00.000Z', 0),
    )
  })

  it('degrau, contato ou horário diferente é outra chave', () => {
    const base = chaveDoDegrau(CONTA, PACIENTE, SABADO_13H, 0)
    expect(chaveDoDegrau(CONTA, PACIENTE, SABADO_13H, 1)).not.toBe(base)
    expect(chaveDoDegrau(CONTA, 'contato-bruno-teste', SABADO_13H, 0)).not.toBe(base)
    expect(chaveDoDegrau(CONTA, PACIENTE, '2026-10-03T16:00:01.000Z', 0)).not.toBe(base)
    expect(chaveDoDegrau('conta-0002', PACIENTE, SABADO_13H, 0)).not.toBe(base)
  })
})
