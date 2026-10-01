import { beforeEach, describe, expect, it, vi } from 'vitest'

// 01/10 — envio da confirmação ao paciente. Banco falso: cada SELECT consome a
// próxima resposta da fila, na ordem em que o envio pergunta (compromisso →
// cópia no mesmo horário → conversa pedida → conversa mais recente → janela
// de 24h). O WhatsApp é um espião.
//
// Dados fictícios (LGPD): nenhum paciente de verdade aqui.

const h = vi.hoisted(() => {
  const state = {
    results: [] as unknown[],
    selects: 0,
    falhaNoBanco: false,
    settings: { bookingConfirmation: true, businessTimezone: 'America/Sao_Paulo' } as Record<string, unknown>,
  }
  const chain = () => {
    state.selects++
    let promise: Promise<unknown> | null = null
    const settle = () => {
      if (!promise) {
        promise = state.falhaNoBanco
          ? Promise.reject(new Error('connection terminated'))
          : Promise.resolve(state.results.shift() ?? [])
      }
      return promise
    }
    const self: unknown = new Proxy(
      {},
      {
        get(_t, prop: string | symbol) {
          if (prop === 'then' || prop === 'catch' || prop === 'finally') {
            const p = settle()
            return (p as unknown as Record<string, (...a: unknown[]) => unknown>)[prop as string].bind(p)
          }
          return () => self
        },
      },
    )
    return self
  }
  return {
    state,
    db: { select: () => chain() },
    send: vi.fn<
      (accountId: string, params: Record<string, unknown>) => Promise<{ messageId: string; whatsappMessageId: string }>
    >(async () => ({ messageId: 'm-1', whatsappMessageId: 'wa-1' })),
  }
})

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  return { ...actual, db: h.db }
})
vi.mock('@/lib/settings/account-settings', () => ({
  getAccountSettings: async () => h.state.settings,
}))
vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/send-message')>()
  return { ...actual, sendMessageToConversation: h.send }
})

import { SendMessageError } from '@/lib/whatsapp/send-message'
import { enviarConfirmacaoDoAgendamento } from './confirmacao-envio'

const AGORA = new Date('2026-10-01T15:00:00.000Z')
const EVENTO = {
  status: 'confirmed',
  startsAt: '2026-10-08 17:00:00+00', // quinta 08/10, 14h em São Paulo
  endsAt: '2026-10-08 18:00:00+00',
  allDay: false,
  contactId: 'c-1',
  calendarName: 'Dr. Exemplo',
  contactName: 'Maria Exemplo',
  isGroup: false,
  optedOut: false,
}
const WAHA = [{ id: 'cv-1', provider: 'waha' }]

const enviar = (extra: Partial<Parameters<typeof enviarConfirmacaoDoAgendamento>[0]> = {}) =>
  enviarConfirmacaoDoAgendamento({
    accountId: 'acc-1',
    eventId: 'ev-1',
    tipo: 'marcacao',
    conversationId: 'cv-1',
    agora: AGORA,
    ...extra,
  })

beforeEach(() => {
  h.state.results = []
  h.state.selects = 0
  h.state.falhaNoBanco = false
  h.state.settings = { bookingConfirmation: true, businessTimezone: 'America/Sao_Paulo' }
  h.send.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('confirmação ao paciente — envio', () => {
  it('marcação: manda UMA vez, na conversa de onde veio, como mensagem automática', async () => {
    h.state.results.push([EVENTO], [], WAHA)

    const r = await enviar()

    expect(r).toBe('enviada')
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send).toHaveBeenCalledWith('acc-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText:
        'Olá, Maria! Sua consulta com Dr. Exemplo está confirmada para quinta-feira, 08/10/2026, às 14h. Qualquer dúvida, é só responder por aqui.',
      // Igual ao lembrete de consulta: não é um atendente respondendo.
      senderType: 'bot',
    })
  })

  it('remarcação: "foi remarcada para"', async () => {
    h.state.results.push([EVENTO], [], WAHA)

    await enviar({ tipo: 'remarcacao' })

    expect(h.send.mock.calls[0]?.[1]?.contentText).toContain('foi remarcada para quinta-feira, 08/10/2026, às 14h')
  })

  it('opção desligada na conta: não envia e nem consulta o banco', async () => {
    h.state.settings = { bookingConfirmation: false }

    const r = await enviar()

    expect(r).toEqual({ naoEnviada: 'a confirmação ao agendar está desligada nesta conta' })
    expect(h.send).not.toHaveBeenCalled()
    expect(h.state.selects).toBe(0)
  })

  it('paciente em "não perturbe": não envia, e o motivo volta para a tela', async () => {
    h.state.results.push([{ ...EVENTO, optedOut: true }])

    const r = await enviar()

    expect(r).toEqual({ naoEnviada: 'o paciente pediu para não receber mensagens (não perturbe)' })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('compromisso no passado: não envia', async () => {
    h.state.results.push([EVENTO])

    const r = await enviar({ agora: new Date('2026-10-09T12:00:00.000Z') })

    expect(r).toEqual({ naoEnviada: 'o horário do compromisso já passou' })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('a mesma consulta já está em outra agenda (ou salva duas vezes): não manda de novo', async () => {
    h.state.results.push([EVENTO], [{ id: 'ev-copia' }])

    const r = await enviar()

    expect(r).toMatchObject({ naoEnviada: expect.stringContaining('outro compromisso neste mesmo horário') })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('a conversa de onde veio não é deste paciente: usa a conversa de WhatsApp mais recente dele', async () => {
    h.state.results.push([EVENTO], [], [], [{ id: 'cv-recente', provider: 'waha' }])

    const r = await enviar({ conversationId: 'cv-de-outro-contato' })

    expect(r).toBe('enviada')
    expect(h.send.mock.calls[0]?.[1]?.conversationId).toBe('cv-recente')
  })

  it('sem conversa de onde veio: usa a mais recente', async () => {
    h.state.results.push([EVENTO], [], [{ id: 'cv-recente', provider: 'waha' }])

    await enviar({ conversationId: null })

    expect(h.send.mock.calls[0]?.[1]?.conversationId).toBe('cv-recente')
  })

  it('paciente sem conversa de WhatsApp: não envia e avisa', async () => {
    h.state.results.push([EVENTO], [], [], [])

    const r = await enviar()

    expect(r).toEqual({ naoEnviada: 'o paciente não tem conversa de WhatsApp com a clínica' })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('WhatsApp oficial fora da janela de 24h: não manda texto livre', async () => {
    const dias = new Date(AGORA.getTime() - 3 * 86_400_000).toISOString()
    h.state.results.push([EVENTO], [], [{ id: 'cv-1', provider: 'meta' }], [{ at: dias }])

    const r = await enviar()

    expect(r).toMatchObject({ naoEnviada: expect.stringContaining('24h') })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('WhatsApp oficial sem nenhuma mensagem do paciente: também não', async () => {
    h.state.results.push([EVENTO], [], [{ id: 'cv-1', provider: 'meta' }], [{ at: null }])

    const r = await enviar()

    expect(r).toMatchObject({ naoEnviada: expect.stringContaining('24h') })
  })

  it('WhatsApp oficial dentro da janela: envia', async () => {
    const recente = new Date(AGORA.getTime() - 3_600_000).toISOString()
    h.state.results.push([EVENTO], [], [{ id: 'cv-1', provider: 'meta' }], [{ at: recente }])

    expect(await enviar()).toBe('enviada')
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it('o WhatsApp recusou: devolve o motivo em português, sem lançar', async () => {
    h.state.results.push([EVENTO], [], WAHA)
    h.send.mockRejectedValueOnce(
      new SendMessageError('send_error', 'Este número não parece estar no WhatsApp.', 502),
    )

    const r = await enviar()

    expect(r).toEqual({ naoEnviada: 'este número não parece estar no WhatsApp' })
  })

  it('erro cru do provedor: frase genérica (o cru fica no log)', async () => {
    h.state.results.push([EVENTO], [], WAHA)
    h.send.mockRejectedValueOnce(new SendMessageError('send_error', 'waha send error: socket hang up', 502))

    const r = await enviar()

    expect(r).toEqual({ naoEnviada: 'o WhatsApp recusou o envio (confira se o canal está conectado)' })
  })

  it('entregue mas não gravado: conta como enviada (não induz a mandar de novo)', async () => {
    h.state.results.push([EVENTO], [], WAHA)
    h.send.mockRejectedValueOnce(
      new SendMessageError('db_error', 'Message sent to Meta but failed to save to DB: boom', 500),
    )

    expect(await enviar()).toBe('enviada')
  })

  it('banco fora do ar: não lança, devolve aviso', async () => {
    h.state.falhaNoBanco = true

    const r = await enviar()

    expect(r).toEqual({ naoEnviada: 'não foi possível preparar a confirmação agora' })
    expect(h.send).not.toHaveBeenCalled()
  })
})
