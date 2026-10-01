import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

// 01/10 — envio da confirmação ao paciente. Banco falso: cada SELECT consome a
// próxima resposta da fila, na ordem em que o envio pergunta (compromisso →
// cópia no mesmo horário → conversa pedida → conversa mais recente → [sem
// conversa: canais de WhatsApp → números da IA] → [oficial: janela de 24h]).
// O WhatsApp, a abertura de conversa, o marcador da IA e a config dos
// lembretes são espiões; o carimbo dos lembretes (db.execute) é capturado.
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
    db: {
      select: () => chain(),
      execute: vi.fn<(q: unknown) => Promise<{ rows: unknown[] }>>(async () => ({ rows: [] })),
    },
    send: vi.fn<
      (accountId: string, params: Record<string, unknown>) => Promise<{ messageId: string; whatsappMessageId: string }>
    >(async () => ({ messageId: 'm-1', whatsappMessageId: 'wa-1' })),
    abrir: vi.fn<(accountId: string, contactId: string, channelId: string) => Promise<{ conversationId: string; created: boolean }>>(
      async () => ({ conversationId: 'cv-nova', created: true }),
    ),
    cobrir: vi.fn<(conversationId: string, at: Date) => Promise<void>>(async () => {}),
    lembretes: vi.fn<(accountId: string, eventId: string) => Promise<unknown[]>>(async () => []),
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
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({ ensureConversationForContact: h.abrir }))
vi.mock('@/lib/ai/reply-marker', () => ({ setCoveredUntil: h.cobrir }))
// A config dos lembretes vem do banco (agente da conversa); o resto da conta —
// quantos degraus venceram e o UPDATE do carimbo — é o código de verdade.
vi.mock('@/lib/ai/followup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/followup')>()
  return { ...actual, lembretesDoCompromisso: h.lembretes }
})

import { readFollowUpConfig } from '@/lib/ai/followup'
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
  nameSource: 'crm',
  contactPhone: '5500900000000',
  isGroup: false,
  optedOut: false,
}
const WAHA = [{ id: 'cv-1', provider: 'waha' }]
const CANAL = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  provider: 'waha',
  status: 'connected',
  dedicatedUserId: null,
  ...extra,
})

const enviar = (extra: Partial<Parameters<typeof enviarConfirmacaoDoAgendamento>[0]> = {}) =>
  enviarConfirmacaoDoAgendamento({
    accountId: 'acc-1',
    eventId: 'ev-1',
    tipo: 'marcacao',
    conversationId: 'cv-1',
    agora: AGORA,
    ...extra,
  })

const dialect = new PgDialect()
/** Os parâmetros de cada UPDATE que o envio mandou ao banco (carimbo dos lembretes). */
const carimbos = () => h.db.execute.mock.calls.map((c) => dialect.sqlToQuery(c[0] as SQL).params)

beforeEach(() => {
  h.state.results = []
  h.state.selects = 0
  h.state.falhaNoBanco = false
  h.state.settings = { bookingConfirmation: true, businessTimezone: 'America/Sao_Paulo' }
  h.send.mockClear()
  h.lembretes.mockImplementation(async () => [])
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
        'Olá, Maria! Sua consulta com o Dr. Exemplo está confirmada para quinta-feira, 08/10/2026, às 14h. Qualquer dúvida, é só responder por aqui.',
      // Igual ao lembrete de consulta: não é um atendente respondendo.
      senderType: 'bot',
    })
  })

  it('remarcação: "foi remarcada para"', async () => {
    h.state.results.push([EVENTO], [], WAHA)

    await enviar({ tipo: 'remarcacao' })

    expect(h.send.mock.calls[0]?.[1]?.contentText).toContain('foi remarcada para quinta-feira, 08/10/2026, às 14h')
  })

  it('só trocou o profissional: "agora é com", sem "remarcada"', async () => {
    h.state.results.push([{ ...EVENTO, calendarName: 'Dra. Fulana Teste' }], [], WAHA)

    await enviar({ tipo: 'profissional' })

    const texto = h.send.mock.calls[0]?.[1]?.contentText as string
    expect(texto).toContain('Sua consulta de quinta-feira, 08/10/2026, às 14h, agora é com a Dra. Fulana Teste.')
    expect(texto).not.toMatch(/remarcada/)
  })

  it('nome que veio do perfil do WhatsApp e é apelido ("Mãe"): "Olá!"', async () => {
    h.state.results.push([{ ...EVENTO, contactName: 'Mãe ❤️', nameSource: 'whatsapp' }], [], WAHA)

    await enviar()

    expect(h.send.mock.calls[0]?.[1]?.contentText).toMatch(/^Olá! Sua consulta/)
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

  it('a mesma consulta já está em outra agenda: não manda de novo, e não afirma que a outra mandou', async () => {
    h.state.results.push([EVENTO], [{ id: 'ev-copia' }])

    const r = await enviar()

    expect(r).toEqual({
      naoEnviada:
        'este paciente já tem outro compromisso neste mesmo horário; para não mandar duas mensagens, esta não foi enviada — confira a conversa',
    })
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

describe('resultado incerto: pode ter chegado (01/10, revisão)', () => {
  const INCERTA = { incerta: 'não deu para confirmar se a mensagem saiu; confira a conversa antes de reenviar' }

  it.each([
    ['WAHA abortou a chamada em 15s', new SendMessageError('send_error', 'waha send error: This operation was aborted', 502)],
    [
      'timeout (texto pronto do friendlySendError)',
      new SendMessageError('send_error', 'O envio demorou demais e não foi confirmado. Verifique a conexão do canal e tente de novo.', 502),
    ],
    ['resposta sem o id da mensagem', new SendMessageError('send_error', 'waha send error: waha sendText: response carried no message id', 502)],
    ['AbortError cru', Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })],
  ])('%s: "confira a conversa", nunca "o WhatsApp recusou"', async (_caso, erro) => {
    h.state.results.push([EVENTO], [], WAHA)
    h.send.mockRejectedValueOnce(erro)

    expect(await enviar()).toEqual(INCERTA)
    // Não dá a conversa por atendida nem carimba lembrete: não sabemos se saiu.
    expect(h.cobrir).not.toHaveBeenCalled()
    expect(h.db.execute).not.toHaveBeenCalled()
  })
})

describe('paciente sem conversa de WhatsApp ("manda no WhatsApp", no balcão) — 01/10, revisão', () => {
  it('abre a conversa num WhatsApp não oficial conectado e envia por ela', async () => {
    h.state.results.push([EVENTO], [], [], [], [CANAL('ch-1')], [])

    const r = await enviar()

    expect(r).toBe('enviada')
    expect(h.abrir).toHaveBeenCalledWith('acc-1', 'c-1', 'ch-1')
    expect(h.send.mock.calls[0]?.[1]?.conversationId).toBe('cv-nova')
  })

  it('prefere o número em que a IA atende ao conectado mais recente', async () => {
    h.state.results.push([EVENTO], [], [], [], [CANAL('ch-novo'), CANAL('ch-da-ia')], [{ ids: ['ch-da-ia'] }])

    await enviar()

    expect(h.abrir).toHaveBeenCalledWith('acc-1', 'c-1', 'ch-da-ia')
  })

  it('sem número da IA: o conectado mais recente; desconectado e oficial ficam de fora', async () => {
    h.state.results.push(
      [EVENTO],
      [],
      [],
      [],
      [
        CANAL('ch-desconectado', { status: 'disconnected' }),
        CANAL('ch-oficial', { provider: 'meta' }),
        CANAL('ch-recente'),
        CANAL('ch-antigo'),
      ],
      [],
    )

    await enviar()

    expect(h.abrir).toHaveBeenCalledWith('acc-1', 'c-1', 'ch-recente')
  })

  it('número dedicado a alguém da equipe fica por último', async () => {
    h.state.results.push([EVENTO], [], [], [], [CANAL('ch-pessoal', { dedicatedUserId: 'u-9' }), CANAL('ch-clinica')], [])

    await enviar()

    expect(h.abrir).toHaveBeenCalledWith('acc-1', 'c-1', 'ch-clinica')
  })

  it('só WhatsApp oficial (Meta): não começa conversa sem template — não envia e diz por quê', async () => {
    h.state.results.push([EVENTO], [], [], [], [CANAL('ch-oficial', { provider: 'meta' })])

    const r = await enviar()

    expect(r).toMatchObject({ naoEnviada: expect.stringContaining('template') })
    expect(h.abrir).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })

  it('nenhum WhatsApp conectado: não envia e diz por quê', async () => {
    h.state.results.push([EVENTO], [], [], [], [CANAL('ch-1', { status: 'disconnected' })])

    const r = await enviar()

    expect(r).toMatchObject({ naoEnviada: expect.stringContaining('nenhum número de WhatsApp está conectado') })
    expect(h.abrir).not.toHaveBeenCalled()
  })

  it('contato sem telefone: não envia, avisa e nem procura canal', async () => {
    h.state.results.push([{ ...EVENTO, contactPhone: null }], [], [], [])

    const r = await enviar()

    expect(r).toMatchObject({ naoEnviada: expect.stringContaining('telefone') })
    expect(h.abrir).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    // compromisso, cópia, conversa pedida, conversa recente — e só.
    expect(h.state.selects).toBe(4)
  })
})

describe('depois de enviar: a IA e os lembretes (01/10, revisão)', () => {
  it('marca a conversa como atendida até agora — a IA não responde mensagem antiga como se tivesse falado por último', async () => {
    h.state.results.push([EVENTO], [], WAHA)

    await enviar()

    expect(h.cobrir).toHaveBeenCalledTimes(1)
    expect(h.cobrir.mock.calls[0]?.[0]).toBe('cv-1')
    expect(h.cobrir.mock.calls[0]?.[1]).toBeInstanceOf(Date)
  })

  it('também no "entregue mas não gravado"', async () => {
    h.state.results.push([EVENTO], [], WAHA)
    h.send.mockRejectedValueOnce(new SendMessageError('db_error', 'Message sent to Meta but failed to save to DB: boom', 500))

    await enviar()

    expect(h.cobrir).toHaveBeenCalledWith('cv-1', expect.any(Date))
  })

  it('paciente escreveu agora há pouco: NÃO marca a conversa como atendida (a IA ainda vai responder)', async () => {
    h.state.results.push([EVENTO], [], WAHA, [{ at: new Date(AGORA.getTime() - 60_000).toISOString() }])

    expect(await enviar()).toBe('enviada')
    expect(h.cobrir).not.toHaveBeenCalled()
  })

  it('envio recusado: não marca nada', async () => {
    h.state.results.push([EVENTO], [], WAHA)
    h.send.mockRejectedValueOnce(new SendMessageError('send_error', 'Este número não parece estar no WhatsApp.', 502))

    await enviar()

    expect(h.cobrir).not.toHaveBeenCalled()
    expect(h.db.execute).not.toHaveBeenCalled()
  })

  describe('confirmação e lembrete não saem juntos', () => {
    // 24h antes e "no dia" (2h antes) — a config do agente da conversa.
    const DEGRAUS = readFollowUpConfig({
      enabled: true,
      meetingReminders: [
        { when: 'before', offsetValue: 24, offsetUnit: 'hours' },
        { when: 'before', offsetValue: 2, offsetUnit: 'hours' },
      ],
    }).meetingReminders
    const daquiA = (horas: number) => new Date(AGORA.getTime() + horas * 3_600_000).toISOString()

    it('marcada para daqui a 20h: o degrau de 24h é carimbado (1) e o "no dia" segue pendente', async () => {
      h.lembretes.mockImplementation(async () => DEGRAUS)
      h.state.results.push(
        [{ ...EVENTO, startsAt: daquiA(20), endsAt: daquiA(21) }],
        [],
        WAHA,
      )

      expect(await enviar()).toBe('enviada')

      expect(h.lembretes).toHaveBeenCalledWith('acc-1', 'ev-1')
      // Reserva ANTES do envio (compromisso, conta, n): GREATEST, este e as cópias.
      expect(carimbos()).toEqual([['ev-1', 'acc-1', 1]])
      expect(h.db.execute.mock.invocationCallOrder[0]).toBeLessThan(h.send.mock.invocationCallOrder[0])
    })

    it('folga: marcada para daqui a 25h, o degrau de 24h (vence em 1h) também fica coberto', async () => {
      h.lembretes.mockImplementation(async () => DEGRAUS)
      h.state.results.push([{ ...EVENTO, startsAt: daquiA(25), endsAt: daquiA(26) }], [], WAHA)

      expect(await enviar()).toBe('enviada')
      expect(carimbos()).toEqual([['ev-1', 'acc-1', 1]])
    })

    it('a confirmação não saiu: a reserva é desfeita (o lembrete volta a valer)', async () => {
      h.lembretes.mockImplementation(async () => DEGRAUS)
      h.db.execute.mockResolvedValueOnce({ rows: [{ id: 'ev-1', antes: 0 }] })
      h.state.results.push([{ ...EVENTO, startsAt: daquiA(20), endsAt: daquiA(21) }], [], WAHA)
      h.send.mockRejectedValueOnce(new SendMessageError('send_error', 'Este número não parece estar no WhatsApp.', 502))

      const r = await enviar()

      expect(r).not.toBe('enviada')
      // 1ª: reserva (n=1). 2ª: devolve para 0, só se ainda estiver em 1 (compare-and-swap).
      expect(carimbos()).toEqual([
        ['ev-1', 'acc-1', 1],
        [0, 'ev-1', 1],
      ])
    })

    it('marcada para daqui a 3 dias: nenhum degrau venceu, nada é carimbado', async () => {
      h.lembretes.mockImplementation(async () => DEGRAUS)
      h.state.results.push([{ ...EVENTO, startsAt: daquiA(72), endsAt: daquiA(73) }], [], WAHA)

      await enviar()

      expect(h.db.execute).not.toHaveBeenCalled()
    })

    it('nenhum agente manda lembrete para esta conversa: nada é carimbado', async () => {
      h.lembretes.mockImplementation(async () => [])
      h.state.results.push([{ ...EVENTO, startsAt: daquiA(20), endsAt: daquiA(21) }], [], WAHA)

      await enviar()

      expect(h.db.execute).not.toHaveBeenCalled()
    })

    it('o carimbo falhou: a confirmação continua "enviada" (já chegou ao paciente)', async () => {
      h.lembretes.mockImplementation(async () => DEGRAUS)
      h.db.execute.mockRejectedValueOnce(new Error('connection terminated'))
      h.state.results.push([{ ...EVENTO, startsAt: daquiA(20), endsAt: daquiA(21) }], [], WAHA)

      expect(await enviar()).toBe('enviada')
    })
  })
})
