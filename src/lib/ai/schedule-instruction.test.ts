import { describe, expect, it } from 'vitest'

import { formatBookedForPrompt, type CompromissoDoContato } from './busy-slots'
import { scheduleInstruction } from './defaults'

// 02/10/2026: telefone da família inteira numa clínica. A IA via só a 1ª
// consulta do contato, sem dizer com quem, e o [[AGENDAR]] sempre movia essa.
// Agora ela vê todas e, na dúvida entre mudar uma e marcar outra, PERGUNTA.
describe('cliente que JÁ TEM consulta(s): a IA pergunta antes de marcar', () => {
  const consultas: CompromissoDoContato[] = [
    {
      startsAt: '2026-10-21T12:30:00.000Z',
      endsAt: '2026-10-21T13:00:00.000Z',
      allDay: false,
      titulo: 'Avaliação · Léo',
      agenda: 'Dra. Marta Teixeira',
      quando: 'qua 21/10 09:30–10:00',
      inicioLocal: '2026-10-21T09:30',
    },
    {
      startsAt: '2026-10-28T17:00:00.000Z',
      endsAt: '2026-10-28T18:00:00.000Z',
      allDay: false,
      titulo: 'Cirurgia · Nina',
      agenda: 'Dr. Otávio Prates',
      quando: 'qua 28/10 14:00–15:00',
      inicioLocal: '2026-10-28T14:00',
    },
  ]
  const lista = formatBookedForPrompt(consultas, { comAgenda: true })!
  const txt = scheduleInstruction({ booked: lista })

  it('a lista traz TODAS, com profissional e a referência que a IA copia no "remarca"', () => {
    expect(lista.split('\n')).toEqual([
      '- qua 21/10 09:30–10:00 · "Avaliação · Léo" · agenda: Dra. Marta Teixeira · ref: 2026-10-21T09:30',
      '- qua 28/10 14:00–15:00 · "Cirurgia · Nina" · agenda: Dr. Otávio Prates · ref: 2026-10-28T14:00',
    ])
    expect(txt).toContain(lista)
  })

  it('na dúvida entre MUDAR uma e marcar OUTRA mantendo, pergunta — e só marca depois da resposta', () => {
    expect(txt).toContain('ASK before booking')
    expect(txt).toContain('Você quer remarcar a consulta de <dia> com <profissional>, ou marcar uma nova e manter essa?')
    expect(txt).toMatch(/with more than one appointment, say which one/)
    expect(txt).toMatch(/Emit \[\[AGENDAR\]\] only AFTER they answer/)
    // Pedido já claro não ganha pergunta de novo.
    expect(txt).toMatch(/If the request is already clear .* do not ask again/)
  })

  it('ensina o 4º campo: nova / remarca <ref>, e o 3º vazio quando não há profissional', () => {
    expect(txt).toContain('|nova]]')
    expect(txt).toContain('|remarca YYYY-MM-DDTHH:MM]]')
    expect(txt).toContain('||nova')
    expect(txt).not.toContain('it never creates a second one')
  })

  // Revisão de 02/10: o bloco da equipe dizia "leave the third field out" e o
  // das consultas dizia "empty". Com 4º campo, "out" põe o modo no lugar do
  // profissional. Com consulta marcada a regra é uma só: VAZIO.
  it('várias agendas + consulta marcada: uma regra só para o 3º campo — VAZIO, nunca "out"', () => {
    const equipe = '- Dra. Marta Teixeira: sem compromissos\n- Dr. Otávio Prates: sem compromissos'
    const comConsulta = scheduleInstruction({ booked: lista, agendasDaEquipe: equipe })
    expect(comConsulta).not.toContain('leave the third field out')
    expect(comConsulta).toContain('leave the third field EMPTY')
    // Sem consulta marcada não há 4º campo: "out" continua valendo.
    expect(scheduleInstruction({ booked: null, agendasDaEquipe: equipe })).toContain('leave the third field out')
  })

  it('não reemite à toa e respeita o prompt da conta que manda esses casos para humano', () => {
    expect(txt).toMatch(/Do NOT emit \[\[AGENDAR\]\] again for an appointment that is already booked/)
    expect(txt).toMatch(/If your business instructions below say .* must go to a human .* follow your instructions instead/)
  })

  it('duas pessoas: um [[AGENDAR]] por resposta (o 2º sumiria sem aviso)', () => {
    expect(txt).toContain('Only ONE [[AGENDAR]] per reply is carried out')
    expect(scheduleInstruction()).toContain('Only ONE [[AGENDAR]] per reply is carried out')
  })

  it('conta com uma agenda só: a lista sai sem o nome da agenda', () => {
    const umaAgenda = formatBookedForPrompt(consultas)!
    expect(umaAgenda).not.toContain('agenda:')
    expect(umaAgenda).toContain('ref: 2026-10-21T09:30')
  })

  it('sem consulta marcada: nada disso entra (o prompt fica como sempre)', () => {
    expect(formatBookedForPrompt([])).toBeNull()
    const semNada = scheduleInstruction({ booked: null })
    expect(semNada).not.toContain('ALREADY HAS')
    expect(semNada).not.toContain('ASK before booking')
  })
})
import { ACTION_CATALOG, ORCH_ACTIONS, levelFor, readPolicy } from '@/lib/orchestration/policy'
import { REVERT_MATRIX } from '@/lib/orchestration/revert'

describe('marcar compromisso com aprovação (09/09)', () => {
  it('sem aprovação: confirma na mesma resposta; com aprovação: diz que VAI confirmar e nunca "marcado"', () => {
    expect(scheduleInstruction()).toMatch(/Confirm the agreed day and time ONCE/)
    const a = scheduleInstruction({ approval: true })
    expect(a).toMatch(/must APPROVE/)
    expect(a).toMatch(/NEVER say it is booked/)
    expect(a).toContain('[[AGENDAR:')
  })
  it('schedule_event está no catálogo com padrão "automática" (comportamento de sempre) e tem reversão "Desmarcar"', () => {
    expect(ORCH_ACTIONS).toContain('schedule_event')
    expect(ACTION_CATALOG.schedule_event.defaultLevel).toBe('auto')
    expect(REVERT_MATRIX.schedule_event.kind).toBe('undo')
    expect(levelFor(readPolicy(null), 'schedule_event')).toBe('auto')
    // a matriz grava em `autonomy.actions` (readPolicy aceita esse formato)
    expect(levelFor(readPolicy({ actions: { schedule_event: 'approve' } }), 'schedule_event')).toBe('approve')
  })
})
