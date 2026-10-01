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
// A conversa por onde o lembrete sai. Os dois do par costumam cair na mesma.
const CONVERSA = 'conversa-whatsapp'
const OUTRA_CONVERSA = 'conversa-oficial'

const SEM_COPIA = { motivo: null, encerra: false }

function compromisso(p: Partial<CompromissoDoLembrete> & { id: string }): CompromissoDoLembrete {
  return {
    accountId: CONTA,
    contactId: PACIENTE,
    startsAt: SABADO_13H,
    status: 'confirmed',
    createdAt: '2026-09-20T12:00:00.000Z',
    remindersSent: 0,
    reminderBlock: null,
    conversationId: CONVERSA,
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
      { decisao: 'envia', canonicoId: null, responsavelId: null, duplicados: [], ...SEM_COPIA },
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

  it('criados no mesmo MILISSEGUNDO: o menor id, como a fila do worker', () => {
    // O Postgres guarda microssegundos; o JS lê até o milissegundo. A fila
    // ordena por date_trunc('milliseconds', created_at) e depois pelo id como
    // texto (COLLATE "C") — então aqui o microssegundo não pode desempatar.
    const x = compromisso({ id: 'evt-1', createdAt: '2026-09-20 12:00:00.123999+00' })
    const y = compromisso({ id: 'evt-2', createdAt: '2026-09-20 12:00:00.123001+00' })
    expect(escolherCanonico([x, y])?.id).toBe('evt-1')
    expect(escolherCanonico([y, x])?.id).toBe('evt-1')
  })

  it('id comparado byte a byte, como COLLATE "C" (não pela língua)', () => {
    const maiuscula = compromisso({ id: 'Evt-9' })
    const minuscula = compromisso({ id: 'evt-1' })
    // 'E' (0x45) vem antes de 'e' (0x65) em "C"; numa collation de idioma não.
    expect(escolherCanonico([minuscula, maiuscula])?.id).toBe('Evt-9')
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
      responsavelId: 'evt-b',
      duplicados: ['evt-a'],
      ...SEM_COPIA,
    })
    expect(decidirLembreteDuplicado({ evento: PROFISSIONAL, outros: [DONA], degrau: 0 })).toEqual({
      decisao: 'espera',
      canonicoId: 'evt-b',
      responsavelId: 'evt-b',
      duplicados: ['evt-b'],
      ...SEM_COPIA,
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

  it('enquanto o canônico não tentou, a cópia não envia em nenhum degrau', () => {
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
    ).toEqual({ decisao: 'envia', canonicoId: null, responsavelId: null, duplicados: [], ...SEM_COPIA })
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

describe('canônico travado na MESMA conversa: a cópia espelha o motivo', () => {
  // A recepção filtra a Agenda por UMA agenda de cada vez — a do profissional,
  // que costuma ser a cópia. O aviso tem que aparecer lá também.
  it('segurado: a cópia ganha o mesmo motivo, sem encerrar o degrau', () => {
    const donaSemTemplate = { ...DONA, reminderBlock: 'sem_template' as const }
    expect(
      decidirLembreteDuplicado({ evento: PROFISSIONAL, outros: [donaSemTemplate], degrau: 0 }),
    ).toEqual({
      decisao: 'espelha',
      canonicoId: 'evt-b',
      responsavelId: 'evt-b',
      duplicados: ['evt-b'],
      motivo: 'sem_template',
      encerra: false,
    })
  })

  it('encerrado travado: a cópia encerra junto e MANTÉM o motivo — não carimba limpo', () => {
    // Último degrau, mais de 6h segurado: o canônico avança o contador SEM ter
    // mandado nada. Carimbar a cópia limpo diria que o paciente foi avisado.
    const donaEncerrada = { ...DONA, remindersSent: 2, reminderBlock: 'ia_pausada' as const }
    const r = decidirLembreteDuplicado({ evento: PROFISSIONAL, outros: [donaEncerrada], degrau: 1 })
    expect(r.decisao).toBe('espelha')
    expect(r.motivo).toBe('ia_pausada')
    expect(r.encerra).toBe(true)
  })

  it('motivo velho de um degrau anterior também espelha — é o último estado conhecido', () => {
    const donaTravadaNoPrimeiro = { ...DONA, remindersSent: 0, reminderBlock: 'envio_falhou' as const }
    expect(
      decidirLembreteDuplicado({ evento: PROFISSIONAL, outros: [donaTravadaNoPrimeiro], degrau: 1 }),
    ).toMatchObject({ decisao: 'espelha', motivo: 'envio_falhou', encerra: false })
  })

  it('cópia sem conversa nenhuma espelha — não teria por onde assumir', () => {
    const profissionalSemConversa = { ...PROFISSIONAL, conversationId: null }
    const donaSemConversa = { ...DONA, conversationId: null, reminderBlock: 'sem_conversa' as const }
    expect(
      decidirLembreteDuplicado({
        evento: profissionalSemConversa,
        outros: [donaSemConversa],
        degrau: 0,
      }),
    ).toMatchObject({ decisao: 'espelha', motivo: 'sem_conversa' })
  })

  it('o canônico travado continua sendo quem tenta — ele não espelha ninguém', () => {
    const donaTravada = { ...DONA, reminderBlock: 'ia_pausada' as const }
    expect(
      decidirLembreteDuplicado({ evento: donaTravada, outros: [PROFISSIONAL], degrau: 0 }).decisao,
    ).toBe('envia')
  })

  it('o canônico NÃO carimba por causa de uma cópia que só encerrou travada', () => {
    // A cópia avançou o contador guardando o motivo: ninguém foi avisado, e o
    // canônico segue tentando (e acaba travando com o motivo dele).
    const profissionalEncerrada = {
      ...PROFISSIONAL,
      remindersSent: 1,
      reminderBlock: 'sem_template' as const,
    }
    expect(
      decidirLembreteDuplicado({ evento: DONA, outros: [profissionalEncerrada], degrau: 0 }).decisao,
    ).toBe('envia')
  })
})

describe('canônico travado em OUTRA conversa: a cópia assume', () => {
  // O evento da IA usa a conversa do NEGÓCIO; o lançado pela recepção, a mais
  // recente do contato. Se a do canônico travou (IA pausada lá, janela oficial
  // fechada sem template), por outra conversa o aviso ainda sai.
  const DONA_TRAVADA = {
    ...DONA,
    conversationId: OUTRA_CONVERSA,
    reminderBlock: 'ia_pausada' as const,
  }

  it('a cópia envia no lugar dele', () => {
    expect(
      decidirLembreteDuplicado({ evento: PROFISSIONAL, outros: [DONA_TRAVADA], degrau: 0 }),
    ).toEqual({
      decisao: 'envia',
      canonicoId: 'evt-b',
      responsavelId: 'evt-a',
      duplicados: ['evt-b'],
      ...SEM_COPIA,
    })
  })

  it('assume também depois que o canônico encerrou o degrau travado', () => {
    // Antes: a cópia carimbava em cima do encerramento e o paciente ficava
    // sem lembrete nenhum, embora a conversa dela funcionasse.
    const donaEncerrada = { ...DONA_TRAVADA, remindersSent: 2 }
    expect(
      decidirLembreteDuplicado({ evento: PROFISSIONAL, outros: [donaEncerrada], degrau: 1 }).decisao,
    ).toBe('envia')
  })

  it('canônico SEM motivo em outra conversa: a cópia ainda espera ele tentar', () => {
    const donaOutraConversa = { ...DONA, conversationId: OUTRA_CONVERSA }
    expect(
      decidirLembreteDuplicado({ evento: PROFISSIONAL, outros: [donaOutraConversa], degrau: 0 })
        .decisao,
    ).toBe('espera')
  })

  it('depois que a cópia avisou, o canônico carimba em vez de repetir', () => {
    const profissionalAvisou = { ...PROFISSIONAL, remindersSent: 1 }
    expect(
      decidirLembreteDuplicado({ evento: DONA_TRAVADA, outros: [profissionalAvisou], degrau: 0 }),
    ).toMatchObject({ decisao: 'carimba', responsavelId: 'evt-a' })
  })
})

describe('trio com conversas diferentes: só um assume', () => {
  const A = compromisso({ id: 'evt-z', createdAt: '2026-09-20T11:00:00.000Z' })
  const B = compromisso({ id: 'evt-y', createdAt: '2026-09-20T12:00:00.000Z' })
  const C = compromisso({ id: 'evt-x', createdAt: '2026-09-20T13:00:00.000Z' })
  const decide = (evento: CompromissoDoLembrete, outros: CompromissoDoLembrete[]) =>
    decidirLembreteDuplicado({ evento, outros, degrau: 0 })

  it('as duas cópias na outra conversa: assume a primeira, a segunda espera por ELA', () => {
    const aTravado = { ...A, conversationId: OUTRA_CONVERSA, reminderBlock: 'sem_template' as const }
    expect(decide(B, [aTravado, C])).toMatchObject({ decisao: 'envia', responsavelId: 'evt-y' })
    expect(decide(C, [aTravado, B])).toMatchObject({ decisao: 'espera', responsavelId: 'evt-y' })
  })

  it('quem assumiu também travou na conversa dela: a outra espelha o motivo DELA', () => {
    const aTravado = { ...A, conversationId: OUTRA_CONVERSA, reminderBlock: 'sem_template' as const }
    const bTravado = { ...B, reminderBlock: 'envio_falhou' as const }
    expect(decide(C, [aTravado, bTravado])).toMatchObject({
      decisao: 'espelha',
      responsavelId: 'evt-y',
      motivo: 'envio_falhou',
    })
  })

  it('uma cópia na conversa do canônico espelha; a da outra conversa assume', () => {
    const aTravado = { ...A, conversationId: OUTRA_CONVERSA, reminderBlock: 'ia_pausada' as const }
    const bNaMesma = { ...B, conversationId: OUTRA_CONVERSA }
    expect(decide(bNaMesma, [aTravado, C])).toMatchObject({
      decisao: 'espelha',
      responsavelId: 'evt-z',
      motivo: 'ia_pausada',
    })
    expect(decide(C, [aTravado, bNaMesma])).toMatchObject({
      decisao: 'envia',
      responsavelId: 'evt-x',
    })
  })

  it('três conversas: a vez passa adiante até a que ainda não travou', () => {
    const aTravado = { ...A, conversationId: 'conversa-1', reminderBlock: 'ia_pausada' as const }
    const bTravado = { ...B, conversationId: 'conversa-2', reminderBlock: 'sem_template' as const }
    const c = { ...C, conversationId: 'conversa-3' }
    expect(decide(c, [aTravado, bTravado])).toMatchObject({
      decisao: 'envia',
      responsavelId: 'evt-x',
    })
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
    // O segundo espelhou um motivo antigo: isso não faz dele o responsável.
    const segundoEspelhado = { ...SEGUNDO, reminderBlock: 'ia_pausada' as const }
    expect(
      decidirLembreteDuplicado({ evento: TERCEIRO, outros: [PRIMEIRO, segundoEspelhado], degrau: 0 }),
    ).toMatchObject({ decisao: 'espera', responsavelId: 'evt-z' })
  })

  it('qualquer um do grupo que resolveu LIMPO vale para todos', () => {
    // Quem resolve carimba o grupo inteiro na hora; isto é a rede de segurança
    // se o carimbo do grupo falhar: o paciente já foi avisado por alguém.
    const segundoResolveu = { ...SEGUNDO, remindersSent: 1 }
    expect(
      decidirLembreteDuplicado({ evento: TERCEIRO, outros: [PRIMEIRO, segundoResolveu], degrau: 0 }),
    ).toMatchObject({ decisao: 'carimba', responsavelId: 'evt-y' })
    expect(
      decidirLembreteDuplicado({ evento: PRIMEIRO, outros: [segundoResolveu, TERCEIRO], degrau: 0 }),
    ).toMatchObject({ decisao: 'carimba', responsavelId: 'evt-y' })
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
