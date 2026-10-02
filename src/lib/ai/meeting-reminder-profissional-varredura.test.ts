import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

/**
 * 02/10 — o profissional chega ao lembrete DE VERDADE: pela varredura inteira,
 * do SELECT ao envio. Banco falso respondendo pelo texto da consulta; IA,
 * WhatsApp e perfil da empresa falsos. O que se confere é o que sai: os
 * params do template e o prompt entregue à IA.
 *
 * Cenário (nomes fictícios): a mesma consulta na agenda principal da dona
 * (convidada) e na subagenda do dentista que atende.
 */

const h = vi.hoisted(() => ({
  execute: vi.fn<(q: unknown) => Promise<{ rows: unknown[] }>>(),
  sendMessage: vi.fn<(acc: string, args: Record<string, unknown>) => Promise<unknown>>(async () => ({})),
  sendText: vi.fn<(args: Record<string, unknown>) => Promise<unknown>>(async () => ({})),
  generate: vi.fn<(args: { systemPrompt: string }) => Promise<{ text: string }>>(async () => ({
    text: 'Olá! Lembrando da sua consulta amanhã às 10h.',
  })),
  convProvider: 'meta' as string,
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  return { ...actual, db: { execute: h.execute } }
})
vi.mock('@/lib/settings/account-settings', () => ({
  getAccountSettings: async () => ({ businessHoursEnabled: false, businessTimezone: 'America/Sao_Paulo' }),
}))
vi.mock('@/lib/whatsapp/send-message', () => ({
  sendMessageToConversation: h.sendMessage,
  friendlySendError: (e: unknown) => String(e),
}))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.sendText, engineSendMedia: vi.fn() }))
vi.mock('./config', () => ({ loadAiConfigById: async () => ({ provider: 'openai', model: 'teste' }) }))
vi.mock('./context', () => ({
  buildConversationContext: async () => [{ role: 'user', content: 'oi' }],
  stripLeadingTimestamp: (s: string) => s,
}))
vi.mock('./generate', () => ({ generateReply: h.generate }))
vi.mock('./company-profile', () => ({
  getCompanyProfile: async () => null,
  formatCompanyProfileForPrompt: () => null,
}))
vi.mock('./catalog', () => ({ formatCatalogForPrompt: async () => null }))

import { runMeetingReminderSweep } from './followup'

const dialect = new PgDialect()
const textoDe = (q: unknown) => dialect.sqlToQuery(q as SQL).sql.replace(/\s+/g, ' ')

const LEMBRETE = {
  when: 'before',
  offsetValue: 24,
  offsetUnit: 'hours',
  instructions: 'Lembre da consulta na clínica da Dra. Fulana Exemplo.',
}
const agente = (lembrete: Record<string, unknown>) => ({
  id: 'ag-0001',
  account_id: 'conta-0001',
  created_by: 'u-0001',
  auto_reply_channel_ids: [],
  is_default: true,
  sole_active: true,
  follow_up: { enabled: true, meetingReminders: [lembrete] },
})

const COPIA_NA_SUBAGENDA = {
  id: 'ev-0002',
  account_id: 'conta-0001',
  contact_id: 'c-0001',
  starts_at: '2026-10-03T13:00:00+00:00',
  status: 'confirmed',
  created_at: '2026-10-01T10:05:00+00:00',
  reminders_sent: 0,
  reminder_block: null,
  conversation_id: 'conv-0001',
  calendar_name: 'Dr. Beltrano Teste',
  calendar_principal: false,
}
const NA_AGENDA_DA_DONA = {
  event_id: 'ev-0001',
  starts_at: '2026-10-03 13:00:00+00',
  reminders_sent: 0,
  contact_id: 'c-0001',
  description: null,
  conversation_id: 'conv-0001',
  created_at: '2026-10-01 10:00:00+00',
  reminder_block: null,
  calendar_name: 'Dra. Fulana Exemplo',
  calendar_principal: true,
  duplicados: [COPIA_NA_SUBAGENDA],
}

/** O banco falso: responde pelo texto da consulta. */
function banco(args: { agente: unknown; compromisso: unknown; agendasDaConta?: number }) {
  let primeira = true
  h.execute.mockImplementation(async (q) => {
    if (primeira) {
      primeira = false
      return { rows: [args.agente] }
    }
    const t = textoDe(q)
    if (t.includes('AS calendar_principal')) return { rows: [args.compromisso] }
    if (t.includes('AS last_inbound_at'))
      return {
        rows: [
          {
            contact_id: 'c-0001',
            channel_id: 'canal-0001',
            ai_agent_id: null,
            provider: h.convProvider,
            contact_name: 'Ana Exemplo',
            last_inbound_at: null,
          },
        ],
      }
    if (t.includes('count(*)::int AS n FROM calendars')) return { rows: [{ n: args.agendasDaConta ?? 1 }] }
    return { rows: [] }
  })
}

beforeEach(() => {
  h.execute.mockReset()
  h.sendMessage.mockClear()
  h.sendText.mockClear()
  h.generate.mockClear()
  // Meio-dia em São Paulo de 02/10: o degrau "24h antes" da consulta de 03/10 às 10h venceu.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-02T15:00:00.000Z'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a varredura leva o profissional ao lembrete', () => {
  it('o SELECT traz o nome da agenda e se ela é a principal, do compromisso e das cópias', async () => {
    h.convProvider = 'meta'
    banco({ agente: agente({ ...LEMBRETE, templateName: 'lembrete', templateParams: ['{nome}'] }), compromisso: NA_AGENDA_DA_DONA })
    await runMeetingReminderSweep()
    const select = h.execute.mock.calls.map((c) => textoDe(c[0])).find((t) => t.includes('AS calendar_principal')) ?? ''
    expect(select).toContain('cal.name AS calendar_name')
    expect(select).toContain('LEFT JOIN calendars cal ON cal.id = e.calendar_id')
    expect(select).toContain("'calendar_name', cal2.name")
    expect(select).toContain('LEFT JOIN calendars cal2 ON cal2.id = d.calendar_id')
  })

  it('template: {profissional} vira o dentista da subagenda, não a dona', async () => {
    h.convProvider = 'meta'
    banco({
      agente: agente({
        ...LEMBRETE,
        templateName: 'lembrete_consulta',
        templateLanguage: 'pt_BR',
        templateParams: ['{nome}', '{profissional}', '{hora}'],
      }),
      compromisso: NA_AGENDA_DA_DONA,
    })

    const r = await runMeetingReminderSweep()

    expect(r.sent).toBe(1)
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
    expect(h.sendMessage.mock.calls[0]?.[1]).toMatchObject({
      messageType: 'template',
      templateName: 'lembrete_consulta',
      templateParams: ['Ana', 'o Dr. Beltrano Teste', '10:00'],
    })
  })

  it('IA: o fato "a consulta é com o Dr. …" entra no prompt, e o texto do operador fica como estava', async () => {
    h.convProvider = 'waha'
    banco({ agente: agente(LEMBRETE), compromisso: NA_AGENDA_DA_DONA })

    await runMeetingReminderSweep()

    expect(h.generate).toHaveBeenCalledTimes(1)
    const prompt = h.generate.mock.calls[0]?.[0].systemPrompt ?? ''
    expect(prompt).toContain('A consulta é com o Dr. Beltrano Teste.')
    expect(prompt).toContain(`Operator guidance:\n${LEMBRETE.instructions}`)
    expect(h.sendText).toHaveBeenCalledTimes(1)
  })

  it('IA sem profissional numa conta com várias agendas: "não cite profissional"', async () => {
    h.convProvider = 'waha'
    banco({
      agente: agente(LEMBRETE),
      compromisso: { ...NA_AGENDA_DA_DONA, calendar_name: 'DR. RADIOLOGIA', calendar_principal: false, duplicados: null },
      agendasDaConta: 12,
    })

    await runMeetingReminderSweep()

    const prompt = h.generate.mock.calls[0]?.[0].systemPrompt ?? ''
    expect(prompt).toContain('Não cite profissional')
    expect(prompt).not.toContain('A consulta é com')
  })

  it('IA sem profissional numa conta com uma agenda só: prompt sem fato (nada muda para ela)', async () => {
    h.convProvider = 'waha'
    banco({
      agente: agente(LEMBRETE),
      compromisso: { ...NA_AGENDA_DA_DONA, calendar_name: 'Minha agenda', calendar_principal: false, duplicados: null },
      agendasDaConta: 1,
    })

    await runMeetingReminderSweep()

    const prompt = h.generate.mock.calls[0]?.[0].systemPrompt ?? ''
    expect(prompt).not.toContain('Appointment fact')
  })
})
