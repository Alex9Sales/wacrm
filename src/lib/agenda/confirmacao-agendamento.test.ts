import { describe, expect, it } from 'vitest'

import {
  ATRASO_DA_CONFIRMACAO_MS,
  baseDaConfirmacao,
  decidirConfirmacao,
  decidirNaFila,
  desfechoDoEnvio,
  diaEHoraNoFuso,
  fraseDaConsulta,
  horaDaFila,
  impedimentoDaConfirmacao,
  isConfirmacaoConhecida,
  isDesfechoDaConfirmacao,
  nomeParaSaudacao,
  notaDaConfirmacaoQueNaoSaiu,
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

  it('só os segundos mudaram (evento do Google regravado pelo modal): nada — a mensagem só diz hora e minuto (02/10)', () => {
    expect(
      tipoDaConfirmacaoNaEdicao({
        antes: { ...antes, startsAt: '2026-10-08 17:00:42+00' },
        depois: { ...antes, startsAt: QUI_14H },
      }),
    ).toBeNull()
    // Um minuto de diferença já é outro horário.
    expect(
      tipoDaConfirmacaoNaEdicao({ antes, depois: { ...antes, startsAt: '2026-10-08T17:01:00.000Z' } }),
    ).toBe('remarcacao')
  })

  describe('mudou SÓ a agenda (mesmo dia e hora) — 01/10, revisão', () => {
    const comNomes = { ...antes, nomeAgenda: 'Dra. Fulana Exemplo' }

    it('agenda de outro profissional: "profissional", nunca "remarcação"', () => {
      expect(
        tipoDaConfirmacaoNaEdicao({
          antes: comNomes,
          depois: { ...comNomes, calendarId: 'cal-b', nomeAgenda: 'Dr. Beltrano Teste' },
        }),
      ).toBe('profissional')
    })

    it('agenda nova genérica (Minha agenda, e-mail, sala): nada a dizer ao paciente', () => {
      for (const nomeAgenda of ['Minha agenda', 'clinica.exemplo@gmail.com', 'Radiologia', 'Implantes', null]) {
        expect(
          tipoDaConfirmacaoNaEdicao({ antes: comNomes, depois: { ...comNomes, calendarId: 'cal-b', nomeAgenda } }),
        ).toBeNull()
      }
    })

    it('o mesmo profissional em outra agenda ("Agenda da Dra. X" → "Dra. X"): nada', () => {
      expect(
        tipoDaConfirmacaoNaEdicao({
          antes: comNomes,
          depois: { ...comNomes, calendarId: 'cal-b', nomeAgenda: 'Agenda da Dra. Fulana Exemplo' },
        }),
      ).toBeNull()
    })

    it('o mesmo profissional escrito de dois jeitos ("Dr. Beltrano" × "Dr Beltrano Teste"): nada', () => {
      expect(
        tipoDaConfirmacaoNaEdicao({
          antes: { ...antes, nomeAgenda: 'Dr. Beltrano Teste' },
          depois: { ...antes, calendarId: 'cal-b', nomeAgenda: 'Dr Beltrano' },
        }),
      ).toBeNull()
      // Primeiro nome igual, sobrenome diferente: é OUTRA pessoa.
      expect(
        tipoDaConfirmacaoNaEdicao({
          antes: { ...antes, nomeAgenda: 'Dr. Beltrano Teste' },
          depois: { ...antes, calendarId: 'cal-b', nomeAgenda: 'Dr. Beltrano Exemplo' },
        }),
      ).toBe('profissional')
    })

    it('da agenda genérica para a do profissional: avisa quem é', () => {
      expect(
        tipoDaConfirmacaoNaEdicao({
          antes: { ...antes, nomeAgenda: 'Minha agenda' },
          depois: { ...antes, calendarId: 'cal-b', nomeAgenda: 'Dr. Beltrano Teste' },
        }),
      ).toBe('profissional')
    })

    it('mudou o dia E a agenda: é remarcação', () => {
      expect(
        tipoDaConfirmacaoNaEdicao({
          antes: comNomes,
          depois: { ...comNomes, calendarId: 'cal-b', nomeAgenda: 'Dr. Beltrano Teste', startsAt: '2026-10-09T17:00:00.000Z' },
        }),
      ).toBe('remarcacao')
    })
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

describe('o modal sabe, antes de salvar, que não vai confirmação (01/10, revisão)', () => {
  const contato = { isGroup: false, optedOut: false }

  it('cancelado, grupo e "não perturbe": diz o porquê (mesmo texto do servidor)', () => {
    expect(impedimentoDaConfirmacao({ status: 'cancelled', contato })).toBe('o compromisso está cancelado')
    expect(impedimentoDaConfirmacao({ status: 'confirmed', contato: { ...contato, isGroup: true } })).toBe(
      'o contato é um grupo, não uma pessoa',
    )
    expect(impedimentoDaConfirmacao({ status: 'confirmed', contato: { ...contato, optedOut: true } })).toBe(
      'o paciente pediu para não receber mensagens (não perturbe)',
    )
  })

  it('nada impede: null', () => {
    expect(impedimentoDaConfirmacao({ status: 'confirmed', contato })).toBeNull()
  })

  it('contato ainda carregando (null) não esconde a caixa: o servidor confere', () => {
    expect(impedimentoDaConfirmacao({ status: 'confirmed', contato: null })).toBeNull()
  })
})

describe('o nome da agenda vira "com {profissional}"?', () => {
  it('Dr./Dra. na frente (com ou sem ponto): com o artigo certo', () => {
    expect(profissionalDaAgenda('Dra. Fulana  Exemplo')).toBe('a Dra. Fulana Exemplo')
    expect(profissionalDaAgenda('Dr. Beltrano Teste')).toBe('o Dr. Beltrano Teste')
    expect(profissionalDaAgenda('Dra Fulana')).toBe('a Dra. Fulana')
    expect(profissionalDaAgenda('Dr Beltrano')).toBe('o Dr. Beltrano')
  })

  it('sem título não cita (2ª revisão: nome de serviço passava como gente)', () => {
    for (const nome of [
      'Beltrano Teste',
      'Primeira Consulta',
      'Convênio Unimed',
      'Sorriso Perfeito',
      'Drenagem Linfática',
      'Equipe Exemplo',
      'Dentística Restauradora',
    ]) {
      expect(profissionalDaAgenda(nome), nome).toBeNull()
    }
  })

  it('grafias brasileiras do título: Drª, Dr.ª, Doutora, Doutor', () => {
    expect(profissionalDaAgenda('Drª Fulana Teste')).toBe('a Dra. Fulana Teste')
    expect(profissionalDaAgenda('Dr.ª Fulana')).toBe('a Dra. Fulana')
    expect(profissionalDaAgenda('Doutora Fulana')).toBe('a Dra. Fulana')
    expect(profissionalDaAgenda('Doutor Beltrano')).toBe('o Dr. Beltrano')
    // Gênero em aberto: não afirma nada.
    expect(profissionalDaAgenda('Dr(a). Fulana')).toBeNull()
  })

  it('"Agenda do/da/-" na frente: fica só o nome', () => {
    expect(profissionalDaAgenda('Agenda do Dr. Exemplo')).toBe('o Dr. Exemplo')
    expect(profissionalDaAgenda('Agenda - Dra. Fulana Teste')).toBe('a Dra. Fulana Teste')
    expect(profissionalDaAgenda('Agenda - Fulana Teste')).toBeNull()
    expect(profissionalDaAgenda('Agenda Dr. Exemplo')).toBe('o Dr. Exemplo')
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
      'Dr.',
    ]) {
      expect(profissionalDaAgenda(nome)).toBeNull()
    }
  })

  it('setor ou exame depois do título não é gente — "DR. RADIOLOGIA" (02/10)', () => {
    // A agenda do setor de imagem numa clínica com uma agenda por profissional:
    // o lembrete diria "sua consulta com o Dr. RADIOLOGIA".
    for (const nome of [
      'DR. RADIOLOGIA',
      'Dr. Radiologia',
      'DRA RADIOLOGIA',
      'Dr. Raio-X',
      'DR RX',
      'Dra. Tomografia',
      'Dr. Laboratório',
      'DR. LABORATORIO',
      'Dr. Imagem',
      'Agenda do Dr. Exames de Imagem',
      'Doutor Ultrassom',
    ]) {
      expect(profissionalDaAgenda(nome), nome).toBeNull()
    }
    // Gente de verdade continua passando, inclusive em caixa alta.
    expect(profissionalDaAgenda('DR. BELTRANO TESTE')).toBe('o Dr. BELTRANO TESTE')
    expect(profissionalDaAgenda('Dra. Fulana Exemplo')).toBe('a Dra. Fulana Exemplo')
    // Nome que só CONTÉM as letras de um setor não cai ("Salazar" ≠ "sala").
    expect(profissionalDaAgenda('Dr. Beltrano Salazar')).toBe('o Dr. Beltrano Salazar')
  })

  it('serviço não é gente — nem com uma palavra, nem com duas (01/10, revisão)', () => {
    // Regra positiva: só cita Dr./Dra. ou nome e sobrenome de pessoa.
    for (const nome of [
      'Implantes',
      'Limpeza',
      'Ortodontia',
      'Clareamento',
      'Retorno',
      'Encaixe',
      'Contatos',
      'Família',
      'Estética Facial',
      'Clareamento Dental',
      'Implantes Dentários',
      'Ortodontia - Dra. Fulana',
      // Uma palavra só: muito mais vezes serviço do que gente. Na dúvida, sem.
      'Fulana',
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
      'Olá, Maria! Sua consulta com o Dr. Exemplo está confirmada para quinta-feira, 08/10/2026, às 14h. Qualquer dúvida, é só responder por aqui.',
    )
  })

  it('remarcação', () => {
    expect(textoDaConfirmacao({ ...base, tipo: 'remarcacao' })).toBe(
      'Olá, Maria! Sua consulta com o Dr. Exemplo foi remarcada para quinta-feira, 08/10/2026, às 14h. Qualquer dúvida, é só responder por aqui.',
    )
  })

  it('a Dra. leva "a"', () => {
    expect(textoDaConfirmacao({ ...base, tipo: 'marcacao', nomeAgenda: 'Dra. Fulana Exemplo' })).toContain(
      'Sua consulta com a Dra. Fulana Exemplo está confirmada',
    )
  })

  it('só trocou o profissional: o mesmo horário como referência e quem atende agora — nunca "remarcada"', () => {
    const t = textoDaConfirmacao({ ...base, tipo: 'profissional', nomeAgenda: 'Dra. Fulana Exemplo' })
    expect(t).toBe(
      'Olá, Maria! Sua consulta de quinta-feira, 08/10/2026, às 14h, agora é com a Dra. Fulana Exemplo. Qualquer dúvida, é só responder por aqui.',
    )
    expect(t).not.toMatch(/remarcada/)
  })

  it('serviço no nome da agenda não vira "com Implantes"', () => {
    for (const nomeAgenda of ['Implantes', 'Limpeza', 'Ortodontia']) {
      expect(textoDaConfirmacao({ ...base, tipo: 'marcacao', nomeAgenda })).toBe(
        'Olá, Maria! Sua consulta está confirmada para quinta-feira, 08/10/2026, às 14h. Qualquer dúvida, é só responder por aqui.',
      )
    }
  })

  it('dia inteiro: sem "às"', () => {
    expect(
      textoDaConfirmacao({ ...base, tipo: 'marcacao', startsAt: '2026-10-08T03:00:00.000Z', allDay: true }),
    ).toBe(
      'Olá, Maria! Sua consulta com o Dr. Exemplo está confirmada para quinta-feira, 08/10/2026. Qualquer dúvida, é só responder por aqui.',
    )
  })

  it('nome do PERFIL do WhatsApp que é apelido ("Mãe", "Deus é fiel") vira "Olá!"', () => {
    for (const nomeContato of ['Mãe', 'Amor ❤️', 'Deus é fiel 🙏', 'Jesus', 'Bebê', 'Princesa', 'Eu', 'Família Exemplo']) {
      expect(textoDaConfirmacao({ ...base, tipo: 'marcacao', nomeContato, nameSource: 'whatsapp' })).toMatch(
        /^Olá! Sua consulta/,
      )
    }
  })

  it('perfil do WhatsApp com nome de gente: chama pelo nome', () => {
    expect(textoDaConfirmacao({ ...base, tipo: 'marcacao', nameSource: 'whatsapp' })).toMatch(/^Olá, Maria! /)
  })

  it('nome digitado no CRM manda, mesmo se parecer apelido', () => {
    // Quem cadastrou escolheu o nome; a lista de apelidos é só para o perfil.
    expect(nomeParaSaudacao('Jesus Exemplo', 'crm')).toBe('Jesus')
    expect(nomeParaSaudacao('Jesus Exemplo', 'phonebook')).toBe('Jesus')
    expect(nomeParaSaudacao('Jesus Exemplo', 'whatsapp')).toBe('')
    // name_source null = contato antigo, nome também veio do perfil.
    expect(nomeParaSaudacao('Jesus Exemplo', null)).toBe('')
  })

  it('perfil com título na frente: olha o nome que vem depois', () => {
    expect(nomeParaSaudacao('Dona Maria Teste', 'whatsapp')).toBe('Maria')
    expect(nomeParaSaudacao('Pastor Joao Teste', null)).toBe('Joao')
    expect(nomeParaSaudacao('Pr. Joao', 'whatsapp')).toBe('Joao')
    for (const perfil of ['Sou de Deus', 'Serva de Deus', 'Madrinha', 'Abençoada']) {
      expect(nomeParaSaudacao(perfil, 'whatsapp'), perfil).toBe('')
    }
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
    for (const tipo of ['marcacao', 'remarcacao', 'profissional'] as const) {
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

// ---------- A fila (02/10): espera e manda só a versão final ----------

describe('a fila espera alguns minutos depois do último salvar', () => {
  it('3 minutos', () => {
    expect(ATRASO_DA_CONFIRMACAO_MS).toBe(180_000)
  })
})

describe('contra o que a próxima confirmação é comparada (modal e fila usam a mesma regra)', () => {
  const atual = { startsAt: QUI_14H, calendarId: 'cal-a', contactId: 'c-1' }
  const conhecido = { startsAt: '2026-10-07T17:00:00.000Z', calendarId: 'cal-b', contactId: 'c-1' }

  it('o que o paciente já sabe manda, com ou sem pendente', () => {
    expect(baseDaConfirmacao({ conhecido, pendente: false, atual })).toBe(conhecido)
    expect(baseDaConfirmacao({ conhecido, pendente: true, atual })).toBe(conhecido)
  })

  it('marcação ainda na fila, sem base: nada (consulta nova para ele)', () => {
    expect(baseDaConfirmacao({ conhecido: null, pendente: true, atual })).toBeNull()
  })

  it('compromisso antigo (de antes da fila) ou criado sem a caixa: como está gravado', () => {
    expect(baseDaConfirmacao({ conhecido: null, pendente: false, atual })).toBe(atual)
  })

  it('compromisso novo: nada', () => {
    expect(baseDaConfirmacao({ conhecido: null, pendente: false, atual: null })).toBeNull()
  })
})

describe('na hora de sair: o que mandar (estado FINAL × o que o paciente sabe)', () => {
  const final = {
    status: 'confirmed',
    startsAt: QUI_14H,
    calendarId: 'cal-b',
    contactId: 'c-1',
    nomeAgenda: 'Dr. Beltrano Teste',
  }

  it('sem base: marcação — com o profissional da agenda FINAL, não o da primeira tentativa', () => {
    expect(decidirNaFila({ final, conhecido: null })).toEqual({ acao: 'enviar', tipo: 'marcacao' })
  })

  it('criou às 18h e corrigiu para 18h30 antes de sair: UMA marcação (o salvar do meio não manda nada)', () => {
    // Nada saiu ainda (conhecido null): só a versão final vai, como marcação.
    expect(decidirNaFila({ final: { ...final, startsAt: '2026-10-08T21:30:00.000Z' }, conhecido: null })).toEqual({
      acao: 'enviar',
      tipo: 'marcacao',
    })
  })

  it('o paciente já sabia de outro horário: remarcação', () => {
    expect(
      decidirNaFila({
        final,
        conhecido: { startsAt: '2026-10-07T17:00:00.000Z', calendarId: 'cal-b', contactId: 'c-1', nomeAgenda: 'Dr. Beltrano Teste' },
      }),
    ).toEqual({ acao: 'enviar', tipo: 'remarcacao' })
  })

  it('confirmação saiu "com a Dra." errada e a recepção trocou a agenda: "agora é com"', () => {
    expect(
      decidirNaFila({
        final,
        conhecido: { startsAt: QUI_14H, calendarId: 'cal-a', contactId: 'c-1', nomeAgenda: 'Dra. Fulana Exemplo' },
      }),
    ).toEqual({ acao: 'enviar', tipo: 'profissional' })
  })

  it('moveu e voltou (o paciente já sabe exatamente isto): não manda', () => {
    expect(
      decidirNaFila({ final, conhecido: { startsAt: '2026-10-08 17:00:00+00', calendarId: 'cal-b', contactId: 'c-1' } }),
    ).toEqual({ acao: 'semMudanca' })
  })

  it('cancelado ou sem paciente antes de sair: descarta (foi a própria recepção que mudou)', () => {
    expect(decidirNaFila({ final: { ...final, status: 'cancelled' }, conhecido: null })).toEqual({
      acao: 'descartar',
      motivo: 'o compromisso foi cancelado',
    })
    expect(decidirNaFila({ final: { ...final, contactId: null }, conhecido: null })).toEqual({
      acao: 'descartar',
      motivo: 'o compromisso ficou sem paciente',
    })
  })

  it('trocou o paciente: marcação para o novo', () => {
    expect(
      decidirNaFila({ final, conhecido: { startsAt: QUI_14H, calendarId: 'cal-b', contactId: 'c-outro' } }),
    ).toEqual({ acao: 'enviar', tipo: 'marcacao' })
  })
})

describe('o desfecho, gravado no compromisso e anotado na conversa', () => {
  const AT = new Date('2026-10-02T13:05:00.000Z')

  it('o que o envio devolveu vira a coluna confirmation_result', () => {
    expect(desfechoDoEnvio('enviada', AT)).toEqual({ status: 'enviada', at: AT.toISOString() })
    expect(desfechoDoEnvio({ naoEnviada: 'nenhum WhatsApp conectado nesta conta' }, AT)).toEqual({
      status: 'naoEnviada',
      motivo: 'nenhum WhatsApp conectado nesta conta',
      at: AT.toISOString(),
    })
    expect(desfechoDoEnvio({ incerta: 'não deu para confirmar' }, AT)).toEqual({
      status: 'incerta',
      motivo: 'não deu para confirmar',
      at: AT.toISOString(),
    })
  })

  it('não enviada: nota com o quando e o motivo', () => {
    expect(
      notaDaConfirmacaoQueNaoSaiu({
        desfecho: { status: 'naoEnviada', motivo: 'nenhum WhatsApp conectado nesta conta', at: AT.toISOString() },
        startsAt: QUI_14H,
        allDay: false,
        tz: SP,
      }),
    ).toBe('⚠️ Confirmação da consulta de quinta-feira, 08/10/2026, às 14h não enviada: nenhum WhatsApp conectado nesta conta.')
  })

  it('incerta: NÃO diz "não enviada" — pode ter chegado', () => {
    const nota = notaDaConfirmacaoQueNaoSaiu({
      desfecho: { status: 'incerta', motivo: 'qualquer', at: AT.toISOString() },
      startsAt: QUI_14H,
      allDay: false,
      tz: SP,
    })
    expect(nota).toBe(
      '⚠️ Confirmação da consulta de quinta-feira, 08/10/2026, às 14h: não deu para confirmar se a mensagem saiu; confira a conversa antes de reenviar.',
    )
    expect(nota).not.toMatch(/não enviada/)
  })

  it('enviada, sem mudança, descartada: nada a anotar', () => {
    for (const status of ['enviada', 'semMudanca', 'descartada'] as const) {
      expect(
        notaDaConfirmacaoQueNaoSaiu({ desfecho: { status, at: AT.toISOString() }, startsAt: QUI_14H, allDay: false, tz: SP }),
      ).toBeNull()
    }
  })

  it('as colunas jsonb só chegam à tela validadas', () => {
    expect(isConfirmacaoConhecida({ startsAt: '2026-10-08T17:00:00+00:00', calendarId: 'cal-a', contactId: null })).toBe(true)
    expect(isConfirmacaoConhecida({ startsAt: 'ontem', calendarId: 'cal-a', contactId: 'c-1' })).toBe(false)
    expect(isConfirmacaoConhecida({ startsAt: QUI_14H, contactId: 'c-1' })).toBe(false)
    expect(isConfirmacaoConhecida(null)).toBe(false)
    expect(isDesfechoDaConfirmacao({ status: 'naoEnviada', motivo: 'x', at: AT.toISOString() })).toBe(true)
    expect(isDesfechoDaConfirmacao({ status: 'enviada', at: AT.toISOString() })).toBe(true)
    expect(isDesfechoDaConfirmacao({ status: 'talvez', at: AT.toISOString() })).toBe(false)
    expect(isDesfechoDaConfirmacao({ status: 'enviada' })).toBe(false)
    expect(isDesfechoDaConfirmacao('enviada')).toBe(false)
  })
})

describe('a hora que a tela mostra (fuso da conta)', () => {
  it('"sai às" arredonda para cima no minuto: o worker passa a cada 30 s', () => {
    // 13:05:40Z = 10:05:40 em São Paulo → 10:06.
    expect(horaDaFila('2026-10-02T13:05:40.000Z', SP)).toBe('10:06')
    // Minuto cheio fica.
    expect(horaDaFila('2026-10-02T13:05:00.000Z', SP)).toBe('10:05')
    // Fuso da conta manda.
    expect(horaDaFila('2026-10-02T13:05:00.000Z', 'America/Manaus')).toBe('09:05')
    expect(horaDaFila('lixo', SP)).toBe('')
  })

  it('"enviada em": dia/mês e hora', () => {
    expect(diaEHoraNoFuso('2026-10-02T13:05:00.000Z', SP)).toBe('02/10 às 10:05')
    // Meia-noite é 00, nunca 24.
    expect(diaEHoraNoFuso('2026-10-02T03:00:00.000Z', SP)).toBe('02/10 às 00:00')
  })
})
