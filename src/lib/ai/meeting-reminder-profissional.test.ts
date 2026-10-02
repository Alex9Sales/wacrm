import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'

import {
  aplicarTokensDoTemplate,
  buildMeetingReminderPrompt,
  profissionalDoCompromisso,
  sqlAgendaPrincipal,
  type MeetingReminder,
} from './followup'
import {
  contaComVariosProfissionais,
  fatoDoProfissional,
  profissionalDoLembrete,
} from './meeting-reminder-profissional'

/**
 * 02/10 — o lembrete da véspera passa a dizer com QUEM é a consulta. Numa
 * clínica com uma agenda do Google por profissional, a IA não sabia de qual
 * agenda era o compromisso; a instrução da conta falava na "clínica da Dra.
 * <dona>" e um paciente de outro dentista entendeu que era com ela.
 *
 * Nomes fictícios (LGPD): nenhum paciente nem profissional de verdade aqui.
 */

const DONA = { nome: 'Dra. Fulana Exemplo', principal: true }
const DENTISTA = { nome: 'Dr. Beltrano Teste', principal: false }
const OUTRA_DENTISTA = { nome: 'Dra. Ciclana Modelo', principal: false }
const RADIOLOGIA = { nome: 'DR. RADIOLOGIA', principal: false }

describe('com quem é a consulta (o grupo de cópias em várias agendas)', () => {
  it('a subagenda do profissional vence a agenda principal da dona', () => {
    // O mesmo evento do Google aparece na agenda da dona (convidada) e na do
    // profissional que atende — em qualquer ordem.
    expect(profissionalDoLembrete([DONA, DENTISTA])).toBe('o Dr. Beltrano Teste')
    expect(profissionalDoLembrete([DENTISTA, DONA])).toBe('o Dr. Beltrano Teste')
  })

  it('só na agenda da dona: é com a dona', () => {
    expect(profissionalDoLembrete([DONA])).toBe('a Dra. Fulana Exemplo')
  })

  it('a subagenda é de um setor ("DR. RADIOLOGIA"): ninguém — a dona não vira a resposta', () => {
    expect(profissionalDoLembrete([DONA, RADIOLOGIA])).toBeNull()
    expect(profissionalDoLembrete([RADIOLOGIA])).toBeNull()
  })

  it('dois profissionais diferentes (irmãos no mesmo horário, contato compartilhado): ninguém', () => {
    expect(profissionalDoLembrete([DENTISTA, OUTRA_DENTISTA])).toBeNull()
    expect(profissionalDoLembrete([DONA, DENTISTA, OUTRA_DENTISTA])).toBeNull()
  })

  it('sem saber qual é a principal (Google desconectado) e dois nomes: ninguém', () => {
    expect(profissionalDoLembrete([{ ...DONA, principal: false }, DENTISTA])).toBeNull()
  })

  it('o mesmo profissional escrito de dois jeitos: ele, com o nome mais completo', () => {
    expect(
      profissionalDoLembrete([
        { nome: 'Dr Beltrano', principal: false },
        { nome: 'Agenda do Dr. Beltrano Teste', principal: false },
      ]),
    ).toBe('o Dr. Beltrano Teste')
  })

  it('agenda genérica ao lado da do profissional não atrapalha', () => {
    expect(profissionalDoLembrete([{ nome: 'Minha agenda', principal: false }, DENTISTA])).toBe(
      'o Dr. Beltrano Teste',
    )
  })

  it('nada que pareça gente: null', () => {
    expect(profissionalDoLembrete([])).toBeNull()
    expect(profissionalDoLembrete([{ nome: 'clinica.exemplo@gmail.com', principal: true }])).toBeNull()
    expect(profissionalDoLembrete([{ nome: null, principal: false }])).toBeNull()
  })
})

describe('profissionalDoCompromisso: só as cópias que o dedup reconheceu entram', () => {
  const linha = {
    calendar_name: 'Dra. Fulana Exemplo',
    calendar_principal: true,
    duplicados: [
      {
        id: 'ev-copia',
        account_id: 'conta-1',
        contact_id: 'c-1',
        starts_at: '2026-10-03T13:00:00.000Z',
        status: 'confirmed',
        created_at: '2026-10-01T10:00:00.000Z',
        reminders_sent: 0,
        reminder_block: null,
        conversation_id: 'conv-1',
        calendar_name: 'Dr. Beltrano Teste',
        calendar_principal: false,
      },
    ],
  }

  it('cópia do grupo na subagenda do profissional: é com ele', () => {
    expect(profissionalDoCompromisso(linha, ['ev-copia'])).toBe('o Dr. Beltrano Teste')
  })

  it('linha que o dedup NÃO pôs no grupo não decide: fica a agenda do próprio compromisso', () => {
    expect(profissionalDoCompromisso(linha, [])).toBe('a Dra. Fulana Exemplo')
  })

  it('sem cópias (json_agg vazio vem null)', () => {
    expect(profissionalDoCompromisso({ ...linha, duplicados: null }, [])).toBe('a Dra. Fulana Exemplo')
  })
})

describe('o fato do profissional no prompt do lembrete', () => {
  const r: MeetingReminder = {
    offsetValue: 24,
    offsetUnit: 'hours',
    when: 'before',
    instructions: 'Lembre da consulta na clínica da Dra. Fulana Exemplo e peça para confirmar.',
    templateName: null,
    templateLanguage: null,
    templateParams: [],
    onlyIfStage: null,
  }
  const QUI_14H = '2026-10-08T17:00:00.000Z'
  const SP = 'America/Sao_Paulo'

  it('com profissional: diz com quem é, com o nome exato, e vale mais que o nome do texto do operador', () => {
    const p = buildMeetingReminderPrompt(r, QUI_14H, SP, null, null, {
      nome: 'o Dr. Beltrano Teste',
      contaComVariosProfissionais: true,
    })
    expect(p).toContain('A consulta é com o Dr. Beltrano Teste.')
    expect(p).toContain('using exactly this name ("o Dr. Beltrano Teste")')
    expect(p).toMatch(/overrides any professional named in the operator guidance/)
    // O texto do operador vai como estava, e o fato vem DEPOIS dele.
    expect(p).toContain(`Operator guidance:\n${r.instructions}`)
    expect(p.indexOf('A consulta é com')).toBeGreaterThan(p.indexOf('Operator guidance:'))
    expect(p).not.toContain('Não cite profissional')
  })

  it('sem profissional, numa conta com várias agendas de profissional: não cite profissional', () => {
    const p = buildMeetingReminderPrompt(r, QUI_14H, SP, null, null, {
      nome: null,
      contaComVariosProfissionais: true,
    })
    expect(p).toContain('Não cite profissional')
    expect(p).not.toContain('A consulta é com')
    expect(p).toContain(`Operator guidance:\n${r.instructions}`)
  })

  it('conta sem várias agendas de profissional e sem profissional: nada muda (sem fato)', () => {
    const sem = buildMeetingReminderPrompt(r, QUI_14H, SP, null, null, {
      nome: null,
      contaComVariosProfissionais: false,
    })
    expect(sem).not.toContain('Appointment fact')
    // Igual ao prompt de antes (o parâmetro é opcional).
    expect(sem).toBe(buildMeetingReminderPrompt(r, QUI_14H, SP, null, null))
  })

  it('fatoDoProfissional: os três casos', () => {
    expect(fatoDoProfissional('a Dra. Ciclana Modelo', false)).toContain('A consulta é com a Dra. Ciclana Modelo.')
    expect(fatoDoProfissional(null, true)).toContain('Não cite profissional')
    expect(fatoDoProfissional(null, false)).toBeNull()
  })

  it('sem profissional: não chama de "sua consulta" — usa a palavra que a conversa já usa', () => {
    // 02/10, revisão: "sua consulta" fixo virava "consulta" uma reunião comercial.
    const f = fatoDoProfissional(null, true) ?? ''
    expect(f).not.toContain('sua consulta')
    expect(f).toContain('using the same word the conversation already uses')
  })
})

describe('várias agendas DE PROFISSIONAL (02/10, revisão)', () => {
  it('duas ou mais agendas com Dr./Dra. no nome: sim', () => {
    expect(contaComVariosProfissionais(['Dra. Fulana Exemplo', 'Dr. Beltrano Teste'])).toBe(true)
    expect(
      contaComVariosProfissionais(['clinica.exemplo@gmail.com', 'Agenda do Dr. Beltrano', 'Dra Ciclana', 'Recepção']),
    ).toBe(true)
  })

  it('franquia com seis agendas do Google sem "Dr.": não — o nome do operador continua valendo', () => {
    const franquia = ['comercial@exemplo.com', 'Comercial', 'Franquias SP', 'Franquias RJ', 'Expansão', 'Reuniões']
    expect(contaComVariosProfissionais(franquia)).toBe(false)
  })

  it('uma só de profissional, setor com título ou nome vazio: não', () => {
    expect(contaComVariosProfissionais(['Dra. Fulana Exemplo', 'Minha agenda', 'Feriados'])).toBe(false)
    expect(contaComVariosProfissionais(['Dra. Fulana Exemplo', 'DR. RADIOLOGIA'])).toBe(false)
    expect(contaComVariosProfissionais([null, undefined, ''])).toBe(false)
    expect(contaComVariosProfissionais([])).toBe(false)
  })
})

describe('template do lembrete: {profissional}', () => {
  const base = { nome: 'Ana', hora: '14:00', data: '08/10' }

  it('vira "o Dr. …" com o artigo, para caber em "com {profissional}"', () => {
    expect(
      aplicarTokensDoTemplate(['{nome}', 'com {profissional}', '{data} às {hora}'], {
        ...base,
        profissional: 'o Dr. Beltrano Teste',
      }),
    ).toEqual(['Ana', 'com o Dr. Beltrano Teste', '08/10 às 14:00'])
  })

  it('sem profissional: "nossa equipe" — nunca a chave crua no celular do paciente, nem parâmetro vazio', () => {
    // 02/10, revisão: vazio a Meta recusa e o degrau do lembrete travava.
    expect(aplicarTokensDoTemplate(['{profissional}', '{PROFISSIONAL}'], { ...base, profissional: null })).toEqual([
      'nossa equipe',
      'nossa equipe',
    ])
    expect(aplicarTokensDoTemplate(['{Profissional}'], base)).toEqual(['nossa equipe'])
    expect(aplicarTokensDoTemplate(['com {profissional}'], { ...base, profissional: '  ' })).toEqual([
      'com nossa equipe',
    ])
    expect(aplicarTokensDoTemplate(['{profissional}'], { ...base, profissional: null }).every((p) => p !== '')).toBe(true)
  })

  it('os tokens de antes continuam iguais', () => {
    expect(aplicarTokensDoTemplate([' {Nome} ', '{HORA}', '{data}'], base)).toEqual(['Ana', '14:00', '08/10'])
  })
})

describe('agenda principal (a da dona) na varredura', () => {
  const dialect = new PgDialect()
  const texto = (alias: 'cal' | 'cal2') => dialect.sqlToQuery(sqlAgendaPrincipal(alias)).sql.replace(/\s+/g, ' ')

  it('compara o id da agenda no Google com o e-mail de uma conexão DA MESMA conta', () => {
    expect(texto('cal')).toContain('cc.account_id = cal.account_id')
    expect(texto('cal')).toContain('lower(cc.google_email) = lower(cal.google_calendar_id)')
    expect(texto('cal2')).toContain('cc.account_id = cal2.account_id')
  })

  it('sem parâmetro e sem comentário SQL (interpolação depois de -- derruba a consulta)', () => {
    const q = dialect.sqlToQuery(sqlAgendaPrincipal('cal2'))
    expect(q.params).toEqual([])
    expect(q.sql).not.toContain('--')
  })
})
