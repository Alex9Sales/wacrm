import { beforeEach, describe, expect, it, vi } from 'vitest'

// 02/10/2026, revisão: aprovar um agendamento em Precisa de você. O que a
// aprovação faz depende do que scheduleEventFromAi fez de fato:
//   - manteve → já havia consulta deste contato no horário: NADA confirmado ao
//     cliente e nenhum "Desfazer" (antes o desfazer CANCELAVA a que existia);
//   - moveu   → "Desfazer" devolve o horário anterior;
//   - criou   → "Desfazer" cancela.
// O agendamento em si é testado em lib/ai/schedule-actions.test.ts; aqui ele é
// trocado por um stub. Dados fictícios.

const h = vi.hoisted(() => ({
  schedule: vi.fn(),
  send: vi.fn(async () => ({ whatsapp_message_id: 'm-1' })),
  note: vi.fn(async () => true),
}))

vi.mock('@/lib/ai/schedule-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/schedule-actions')>()),
  scheduleEventFromAi: h.schedule,
}))
vi.mock('@/lib/google/sync', () => ({ pushEventToGoogle: vi.fn() }))
vi.mock('@/lib/queue/queues', () => ({ enqueueScheduledMessage: vi.fn() }))
vi.mock('@/lib/settings/account-settings', () => ({ getAccountSettings: vi.fn(async () => ({})) }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.send }))
vi.mock('@/lib/ai/close-actions', () => ({ postInternalNote: h.note }))
vi.mock('@/lib/cadences/cadence', () => ({ cancelEnrollment: vi.fn(), enrollContactInCadence: vi.fn() }))
vi.mock('@/lib/events/publish', () => ({ publishEvent: vi.fn() }))
vi.mock('@/lib/whatsapp/send-message', () => ({ sendMessageToConversation: vi.fn() }))
vi.mock('@/lib/ai/followup', () => ({ planStageFollowUp: vi.fn() }))
vi.mock('@/lib/pipelines/stage-tasks', () => ({ autoCreateStageTasks: vi.fn() }))
vi.mock('@/lib/collections/outreach', () => ({ resolveCollectionTargets: vi.fn() }))
vi.mock('@/lib/collections/links-sent', () => ({ linksAlreadySent: vi.fn() }))
vi.mock('@/lib/collections/reminders', () => ({ reminderStillPending: vi.fn() }))

import { executeOrchestrationAction } from './actions'

const INPUT = {
  accountId: 'conta-1',
  actorUserId: 'u-aprovou',
  agentId: null,
  action: 'schedule_event' as const,
  contactId: 'contato-1',
  dealId: null,
  conversationId: 'conv-1',
  text: null,
  reason: 'Cliente combinou',
  payload: { startsLocal: '2026-10-23T10:00', title: 'Avaliação · Bianca', timezone: 'America/Sao_Paulo', modo: { tipo: 'nova' } },
}

beforeEach(() => {
  h.schedule.mockReset()
  h.send.mockClear()
  h.note.mockClear()
})

describe('aprovar schedule_event (revisão de 02/10)', () => {
  it('manteve (já existe consulta deste contato no horário): erro, NADA confirmado ao cliente, sem desfazer', async () => {
    h.schedule.mockResolvedValue({
      eventId: 'ev-davi',
      startsAt: '2026-10-23T13:00:00.000Z',
      title: 'Avaliação · Davi',
      acao: 'manteve',
      rescheduled: false,
    })
    const r = await executeOrchestrationAction(INPUT)

    expect(r).toEqual({
      ok: false,
      error: 'Já existe consulta deste contato nesse horário: "Avaliação · Davi" — nada foi marcado.',
    })
    expect(h.send).not.toHaveBeenCalled()
    expect(r.revertState).toBeUndefined()
  })

  it('moveu: confirma ao cliente e o desfazer RESTAURA o horário anterior', async () => {
    h.schedule.mockResolvedValue({
      eventId: 'ev-davi',
      startsAt: '2026-10-23T13:00:00.000Z',
      title: 'Avaliação · Davi',
      tituloAntigo: 'Avaliação · Davi',
      acao: 'moveu',
      rescheduled: true,
      movidoDe: '2026-10-21T12:30:00.000Z',
      movidoDeFim: '2026-10-21T13:00:00.000Z',
      ficouNoHorarioAntigo: [{ startsAt: '2026-10-21T12:30:00.000Z', agenda: 'Dr. Otávio Prates', titulo: 'Avaliação · Davi' }],
    })
    const r = await executeOrchestrationAction({ ...INPUT, payload: { ...INPUT.payload, modo: { tipo: 'remarca', deLocal: '2026-10-21T09:30' } } })

    expect(r.ok).toBe(true)
    expect(r.revertState).toEqual({
      acao: 'moveu',
      eventId: 'ev-davi',
      prevStartsAt: '2026-10-21T12:30:00.000Z',
      prevEndsAt: '2026-10-21T13:00:00.000Z',
      startsAt: '2026-10-23T13:00:00.000Z',
      conversationId: 'conv-1',
    })
    expect(h.send).toHaveBeenCalledTimes(1)
    expect((h.send.mock.calls[0] as unknown[])[0]).toMatchObject({ text: expect.stringMatching(/^Remarcado! ✅ Avaliação · Davi:/) })
    // A nota diz de quem é a consulta e o que ficou no horário antigo.
    const nota = ((h.note.mock.calls[0] as unknown[])[0] as { text: string }).text
    expect(nota).toContain('remarcou a consulta "Avaliação · Davi"')
    expect(nota).toContain('⚠️ Ficou outra consulta deste contato')
  })

  it('criou: o desfazer cancela (como sempre)', async () => {
    h.schedule.mockResolvedValue({
      eventId: 'ev-novo',
      startsAt: '2026-10-23T13:00:00.000Z',
      title: 'Avaliação · Bianca',
      acao: 'criou',
    })
    const r = await executeOrchestrationAction(INPUT)

    expect(r.ok).toBe(true)
    expect(r.revertState).toEqual({ acao: 'criou', eventId: 'ev-novo', conversationId: 'conv-1' })
    expect((h.send.mock.calls[0] as unknown[])[0]).toMatchObject({ text: expect.stringMatching(/^Confirmado! ✅/) })
  })

  it('não fez nada (profissional ocupado, sem modo…): o erro é o porquê, nada confirmado', async () => {
    h.schedule.mockResolvedValue({
      naoAchou: true,
      motivo: 'ocupado',
      deLocal: null,
      startsLocal: '2026-10-23T10:00',
      titulo: 'Avaliação · Bianca',
      conflito: { titulo: 'Avaliação · Davi', agenda: 'Dr. Otávio Prates', startsAt: '2026-10-23T13:00:00.000Z' },
    })
    const r = await executeOrchestrationAction(INPUT)

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/a agenda Dr\. Otávio Prates já tem uma consulta deste contato nesse horário/)
    expect(h.send).not.toHaveBeenCalled()
  })

  it('o pedido vai ao agendamento sem duração fixa (os novos não trazem mais 60)', async () => {
    h.schedule.mockResolvedValue({ eventId: 'ev-novo', startsAt: '2026-10-23T13:00:00.000Z', title: 'x', acao: 'criou' })
    await executeOrchestrationAction(INPUT)
    expect(h.schedule).toHaveBeenCalledWith(expect.objectContaining({ durationMin: undefined, modo: { tipo: 'nova' } }))
  })
})
