import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  // Cycle-safe stringify — drizzle SQL objects can hold circular refs.
  safeStringify(o: unknown): string {
    const seen = new WeakSet<object>()
    return JSON.stringify(o, (_k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return undefined
        seen.add(v)
      }
      return v
    })
  },
  loadAiConfig: vi.fn(),
  hasAgent: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  setCoveredUntil: vi.fn(),
  // 🕰️ contador de respostas velhas descartadas (stale-reply.ts).
  bumpCounter: vi.fn(),
  // 🔁 transferência por etiqueta (transfer-actions.ts).
  applyTransfer: vi.fn(),
  // 🔁 reagendamento pós-janela (humano digitando / barge-in) → fila mockada.
  enqueueRecheck: vi.fn(),
  // 🧾 marcador [[COBRANCA:]] (collections/reply + reply-context).
  openDebtForPrompt: vi.fn(),
  applyCollectionReply: vi.fn(),
  evaluateCollectionMarker: vi.fn(),
  claimReplyNote: vi.fn(),
  postInternalNote: vi.fn(),
  // 🙋 encerramento (perda/troca de funil decide pausa × desliga) e aviso ao dono.
  applyCloseActions: vi.fn(),
  sendOwnerAlert: vi.fn(),
  // 📅 Agendar (revisão de 02/10): aviso ao dono e o agendamento em si.
  notifyUsers: vi.fn(),
  scheduleEventFromAi: vi.fn(),
  state: {
    // 📅 Pedido de agendamento com aprovação: o que o INSERT devolve (vazio =
    // conflito no índice de pedido pendente), o que foi inserido e o pedido
    // pendente que a leitura acha.
    insertReturning: [] as { id: string }[],
    inserts: [] as Record<string, unknown>[],
    pendingSchedule: [] as { payload: unknown }[],
    // 🏁 marcador "até onde a última resposta viu" (reply-marker.ts):
    // string ISO = há marca · null = sem marca · undefined = Redis fora.
    coveredUntil: null as string | null | undefined,
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    recentHumanMsgs: [] as { id: string }[],
    // 🏁 guard anti-eco: a última msg não-interna da conversa (com orderBy).
    lastMessages: [{ senderType: 'customer', createdAt: '2026-09-01T15:00:00.000Z' }] as {
      senderType: string
      createdAt?: string
    }[],
    // Respostas em ORDEM para as leituras com orderBy+limit (guard, checagens
    // de resposta velha…). Vazia = cai em lastMessages.
    orderedReads: [] as { senderType: string; createdAt?: string }[][],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    sqlCalls: [] as string[],
    // 🙋 Pausa pós-transferência (handoff-pause.ts):
    // notas "A IA pediu um humano" nas últimas 24h, lidas pro contexto do prompt…
    handoffNotes: [] as { handoffAt: string }[],
    // …e a contagem delas que o finishHandoff faz ANTES de gravar a nova.
    priorHandoffs: 0,
    // Contagem que falha (banco fora) — a transferência segue como 1ª.
    countThrows: false,
  },
}))

// Multi-agente: o auto-reply agora roteia por canal (loadAiConfigForChannel)
// e faz um early-out barato (hasActiveAutoReplyAgent). Mapeamos os dois para
// os mocks existentes — o roteamento por canal é testado em agents.ts.
vi.mock('./config', () => ({
  loadAiConfigForChannel: h.loadAiConfig,
  loadAiConfigById: vi.fn(async () => null),
}))
vi.mock('./agents', () => ({ hasActiveAutoReplyAgent: h.hasAgent }))
vi.mock('./context', () => ({
  buildConversationContext: h.buildConversationContext,
  stripLeadingTimestamp: (s: string) => s,
  loadContactHistoryDigest: vi.fn(async () => null),
}))
vi.mock('./knowledge', () => ({
  retrieveKnowledge: h.retrieveKnowledge,
  // aviso "a base não cobre esta pergunta" — sem base indexada nos testes
  hasKnowledgeChunks: vi.fn(async () => false),
}))
vi.mock('@/lib/queue/queues', () => ({
  enqueueAiReplyDebounced: h.enqueueRecheck,
}))
vi.mock('./reply-marker', () => ({
  acquireReplyLock: vi.fn(async () => 'lock-de-teste'),
  releaseReplyLock: vi.fn(async () => {}),
  getCoveredUntil: async () =>
    h.state.coveredUntil === undefined
      ? undefined
      : h.state.coveredUntil
        ? new Date(h.state.coveredUntil)
        : null,
  setCoveredUntil: h.setCoveredUntil,
  bumpCounter: h.bumpCounter,
  kvDel: vi.fn(async () => {}),
}))
vi.mock('./transfer-actions', () => ({
  listRoutingTags: async () => ['Responsável'],
  applyTransfer: h.applyTransfer,
}))
vi.mock('@/lib/cdl/metrics', () => ({
  buildCustomerFactsBlock: vi.fn(async () => null),
}))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
// Ações do agente (Fase 1/2): no-op nos testes de elegibilidade do auto-reply.
vi.mock('./close-actions', () => ({
  listAccountTagNames: async () => [],
  applyTagsByName: async () => [],
  loadDealCloseContext: async () => null,
  applyCloseActions: h.applyCloseActions,
  postInternalNote: h.postInternalNote,
  createDealFromAi: async () => null,
  // Linha "origem" do aviso de transferência — sem card nos testes.
  handoffDealLine: async () => null,
}))
vi.mock('@/lib/alerts/owner-alerts', () => ({ sendOwnerAlert: h.sendOwnerAlert }))
// 🧾 Cobrança: sem estes mocks, openDebtForPrompt lia o db mockado e voltava
// sempre null — o caminho do marcador nunca rodava nos testes (revisão 16/09).
vi.mock('@/lib/collections/reply', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/collections/reply')>()),
  openDebtForPrompt: h.openDebtForPrompt,
  applyCollectionReply: h.applyCollectionReply,
}))
vi.mock('@/lib/collections/reply-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/collections/reply-context')>()),
  evaluateCollectionMarker: h.evaluateCollectionMarker,
  claimReplyNote: h.claimReplyNote,
}))

// 📅 Agendar: o agendamento, os horários ocupados e o aviso ao dono trocados
// por stubs (cada um é testado no próprio arquivo).
vi.mock('./schedule-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./schedule-actions')>()),
  scheduleEventFromAi: h.scheduleEventFromAi,
}))
vi.mock('./busy-slots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./busy-slots')>()),
  loadBusySlots: vi.fn(async () => []),
  loadBusyByCalendar: vi.fn(async () => ({ agendas: [], ocupados: new Map() })),
  loadBookedForContact: vi.fn(async () => []),
}))
vi.mock('@/lib/google/sync', () => ({ syncAccountCalendars: vi.fn(async () => {}) }))
vi.mock('@/lib/orchestration/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/actions')>()),
  notifyUsers: h.notifyUsers,
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  return {
    ...actual,
    db: {
      // 📅 Pedido de agendamento com aprovação (o único INSERT com RETURNING
      // que estes testes exercitam).
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          h.state.inserts.push(v)
          const done = Promise.resolve(undefined)
          return Object.assign(done, {
            onConflictDoNothing: () => ({ returning: async () => h.state.insertReturning }),
            returning: async () => h.state.insertReturning,
          })
        },
      }),
      // Two select chains: automations (auto-responder guard) and
      // conversations (eligibility read). Distinguished by the table
      // passed to .from() — real table objects survive via importOriginal.
      select: (fields?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          // Leituras "quem falou e quando" (guard anti-eco e checagens de
          // resposta velha) podem vir de uma fila ordenada no teste.
          const isWhoWhen =
            !!fields && Object.keys(fields).sort().join(',') === 'createdAt,senderType'
          // 🙋 Leituras da pausa pós-transferência, pelo formato dos campos.
          const isHandoffCount = !!fields && 'handoffs' in fields
          const isHandoffContext = !!fields && 'handoffAt' in fields
          // The eligibility read joins contacts (for is_group); the automations
          // guard doesn't. `innerJoin` returns the same chain so both shapes
          // resolve through the same where().limit().
          const chain: {
            innerJoin: () => typeof chain
            where: () => {
              limit: () => Promise<unknown[]>
              orderBy: () => { limit: () => Promise<unknown[]> }
            }
          } = {
            innerJoin: () => chain,
            where: () => {
              // count(*) sem limit: a própria cadeia é aguardada.
              if (isHandoffCount) {
                const counted = h.state.countThrows
                  ? Promise.reject(new Error('banco fora'))
                  : Promise.resolve([{ handoffs: h.state.priorHandoffs }])
                return Object.assign(counted, {
                  limit: () => counted,
                  orderBy: () => ({ limit: () => counted }),
                })
              }
              if (isHandoffContext) {
                const notes = Promise.resolve(h.state.handoffNotes)
                return { limit: () => notes, orderBy: () => ({ limit: () => notes }) }
              }
              // 📅 O pedido de agendamento pendente (revisão de 02/10).
              if (table === actual.agentActionRequests && !!fields && 'payload' in fields) {
                const pend = Promise.resolve(h.state.pendingSchedule)
                return { limit: () => pend, orderBy: () => ({ limit: () => pend }) }
              }
              return {
                limit: () => {
                  if (table === actual.automations) {
                    return Promise.resolve(h.state.autoResponders)
                  }
                  if (table === actual.messages) {
                    // 🤫 gate do barge-in: msgs de HUMANO recentes na conversa.
                    return Promise.resolve(h.state.recentHumanMsgs ?? [])
                  }
                  return Promise.resolve(h.state.conv ? [h.state.conv] : [])
                },
                // 🏁 guard anti-eco (messages + orderBy + limit): última msg.
                orderBy: () => ({
                  limit: () =>
                    Promise.resolve(
                      isWhoWhen && h.state.orderedReads.length > 0
                        ? (h.state.orderedReads.shift() ?? [])
                        : (h.state.lastMessages ?? []),
                    ),
                }),
              }
            },
          }
          return chain
        },
      }),
      update: () => ({
        set: (payload: Record<string, unknown>) => ({
          where: () => {
            h.state.updatePayload = payload
            return Promise.resolve()
          },
        }),
      }),
      // claim_ai_reply_slot — serialized SQL carries the fn name + params.
      execute: (query: unknown) => {
        h.state.sqlCalls.push(h.safeStringify(query))
        return Promise.resolve({ rows: [{ claimed: h.state.claim }] })
      },
    },
  }
})

import { dispatchInboundToAiReply } from './auto-reply'
import { HANDOFF_NOTE_PREFIX } from './handoff-pause'
import { parseCloseDirectives } from './defaults'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyChannelIds: [],
    autoReplyMaxPerConversation: 3,
    autoReplyHoursMode: 'always',
    embeddingsApiKey: null,
    signatureName: null,
    signatureEnabled: false,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assignedAgentId: null,
    aiAutoreplyDisabled: false,
    aiReplyCount: 0,
    isGroup: false,
  }
  h.state.autoResponders = []
  h.state.recentHumanMsgs = []
  h.state.lastMessages = [{ senderType: 'customer', createdAt: '2026-09-01T15:00:00.000Z' }]
  h.state.coveredUntil = null
  h.state.orderedReads = []
  h.setCoveredUntil.mockReset()
  h.enqueueRecheck.mockReset()
  h.bumpCounter.mockReset()
  h.bumpCounter.mockResolvedValue(1)
  h.applyTransfer.mockReset()
  h.applyTransfer.mockResolvedValue({ assignedUserId: 'user-2', tag: 'Responsável' })
  h.openDebtForPrompt.mockReset()
  h.openDebtForPrompt.mockResolvedValue(null)
  h.applyCollectionReply.mockReset()
  h.applyCollectionReply.mockResolvedValue({ applied: false, note: '' })
  h.evaluateCollectionMarker.mockReset()
  h.claimReplyNote.mockReset()
  h.claimReplyNote.mockResolvedValue(true)
  h.postInternalNote.mockReset()
  h.postInternalNote.mockResolvedValue(true)
  h.applyCloseActions.mockReset()
  h.applyCloseActions.mockResolvedValue({ resolved: false, movedTo: null, lost: false })
  h.sendOwnerAlert.mockReset()
  h.sendOwnerAlert.mockResolvedValue(undefined)
  h.notifyUsers.mockReset()
  h.notifyUsers.mockResolvedValue(1)
  h.scheduleEventFromAi.mockReset()
  h.scheduleEventFromAi.mockResolvedValue(null)
  h.state.insertReturning = []
  h.state.inserts = []
  h.state.pendingSchedule = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.sqlCalls = []
  h.state.handoffNotes = []
  h.state.priorHandoffs = 0
  h.state.countThrows = false
  h.hasAgent.mockResolvedValue(true)
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('🏁 anti-eco: última msg NÃO é do cliente → não gera (chase já coberto)', async () => {
    h.state.lastMessages = [{ senderType: 'bot' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('🏁 anti-eco: humano respondeu por último → IA não fala por cima', async () => {
    h.state.lastMessages = [{ senderType: 'agent' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('🏁 marcador: IA falou por último, mas o cliente falou DEPOIS do que a última resposta viu → RESPONDE (caso 01/09)', async () => {
    h.state.coveredUntil = '2026-09-01T15:52:10.000Z'
    h.state.lastMessages = [
      { senderType: 'bot', createdAt: '2026-09-01T15:52:39.000Z' },
      { senderType: 'customer', createdAt: '2026-09-01T15:52:31.000Z' },
    ]
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('🏁 marcador: msg do cliente JÁ COBERTA pela última resposta → não repete, nem em rechecagem (caso 01/09)', async () => {
    h.state.coveredUntil = '2026-09-01T15:52:35.000Z'
    h.state.lastMessages = [
      { senderType: 'bot', createdAt: '2026-09-01T15:52:39.000Z' },
      { senderType: 'customer', createdAt: '2026-09-01T15:52:31.000Z' },
    ]
    await dispatchInboundToAiReply({ ...ARGS, raceChase: true })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('🏁 marcador ausente (Redis fora): rechecagem de corrida passa, job normal não', async () => {
    h.state.coveredUntil = undefined
    h.state.lastMessages = [
      { senderType: 'bot', createdAt: '2026-09-01T15:52:39.000Z' },
      { senderType: 'customer', createdAt: '2026-09-01T15:52:31.000Z' },
    ]
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    await dispatchInboundToAiReply({ ...ARGS, raceChase: true })
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('🏁 humano falou por último → a IA cala, mesmo com msg não coberta e em rechecagem', async () => {
    h.state.coveredUntil = '2026-09-01T15:52:10.000Z'
    h.state.lastMessages = [
      { senderType: 'agent', createdAt: '2026-09-01T15:52:39.000Z' },
      { senderType: 'customer', createdAt: '2026-09-01T15:52:31.000Z' },
    ]
    await dispatchInboundToAiReply({ ...ARGS, raceChase: true })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  // 🕰️ Caso de 15/09: "Cartão" e, 15 s depois, "quantos minutos?" —
  // a resposta ao "Cartão" já não servia e saiu mesmo assim.
  const DEPOIS_DA_LEITURA = '2999-01-01T00:00:00.000Z'

  it('🕰️ cliente escreveu durante a geração → a resposta velha NÃO sai e a rechecagem responde tudo junto (caso 15/09)', async () => {
    h.state.lastMessages = [{ senderType: 'customer', createdAt: DEPOIS_DA_LEITURA }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.sqlCalls).toHaveLength(0) // nem gasta vaga do limite
    expect(h.enqueueRecheck).toHaveBeenCalledWith(expect.objectContaining({ raceChase: true }), expect.any(Number))
    expect(h.setCoveredUntil).not.toHaveBeenCalled()
  })

  it('🕰️ freio: passou de 2 descartes seguidos → a resposta sai (cliente que escreve sem parar)', async () => {
    h.state.lastMessages = [{ senderType: 'customer', createdAt: DEPOIS_DA_LEITURA }]
    h.bumpCounter.mockResolvedValue(3)
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('🕰️ Redis fora: sem contador, manda como antes', async () => {
    h.state.lastMessages = [{ senderType: 'customer', createdAt: DEPOIS_DA_LEITURA }]
    h.bumpCounter.mockResolvedValue(undefined)
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('🕰️ mensagem chegou durante o "digitando…" (caso 16/09) → não manda e devolve a vaga', async () => {
    const antes = { senderType: 'customer', createdAt: '2026-09-01T15:00:00.000Z' }
    h.state.orderedReads = [
      [antes], // guard anti-eco: última msg é do cliente
      [], // 1ª checagem (antes da vaga): nada novo ainda
      [{ senderType: 'customer', createdAt: DEPOIS_DA_LEITURA }], // depois da pausa: chegou
    ]
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.sqlCalls).toHaveLength(1) // a vaga foi ocupada…
    expect(h.engineSendText).not.toHaveBeenCalled() // …mas nada saiu
    expect(Object.keys(h.state.updatePayload ?? {})).toEqual(['aiReplyCount']) // …e foi devolvida
    expect(h.enqueueRecheck).toHaveBeenCalledWith(expect.objectContaining({ raceChase: true }), expect.any(Number))
  })

  it('🕰️ turno com efeito (nota pra equipe) nunca é descartado', async () => {
    h.state.lastMessages = [{ senderType: 'customer', createdAt: DEPOIS_DA_LEITURA }]
    h.generateReply.mockResolvedValue({ text: 'Anotado! [[NOTA:troco para R$ 200]]', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
    expect(h.bumpCounter).not.toHaveBeenCalled()
  })

  it('🏁 marcador é gravado depois de a resposta sair', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
    expect(h.setCoveredUntil).toHaveBeenCalledWith('conv-1', expect.any(Date))
  })

  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.sqlCalls).toHaveLength(1)
    expect(h.state.sqlCalls[0]).toContain('claim_ai_reply_slot')
    expect(h.state.sqlCalls[0]).toContain('conv-1') // conversation param
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('🤫 barge-in: humano respondeu há pouco → IA fica em silêncio E reagenda pro fim da janela', async () => {
    h.state.recentHumanMsgs = [{ id: 'm-human' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    // silêncio temporário: NÃO desliga a IA
    expect(h.state.updatePayload).toBeNull()
    // …mas a msg do cliente não fica pendurada: volta a checar quando a janela acabar
    // (caso 01/09).
    expect(h.enqueueRecheck).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
      expect.any(Number),
    )
    const delay = h.enqueueRecheck.mock.calls[0][1] as number
    expect(delay).toBeGreaterThan(0)
  })

  it('👤 humano digitando (humanPresentUntil no futuro) → IA recua e reagenda pro fim da trava', async () => {
    h.state.conv = { ...(h.state.conv as object), humanPresentUntil: new Date(Date.now() + 30_000).toISOString() }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.enqueueRecheck).toHaveBeenCalledTimes(1)
    const delay = h.enqueueRecheck.mock.calls[0][1] as number
    expect(delay).toBeGreaterThanOrEqual(30_000)
    expect(delay).toBeLessThan(40_000)
  })

  it('caminho feliz NÃO reagenda nada', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
    expect(h.enqueueRecheck).not.toHaveBeenCalled()
  })

  it('🔊 responder por áudio OFF: [[AUDIO]] vira texto normal', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ audioRepliesEnabled: false }))
    h.generateReply.mockResolvedValue({ text: '[[AUDIO]]Oi, tudo bem?', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Oi, tudo bem?' }),
    )
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.sqlCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('NEVER replies in a group thread (hard lock)', async () => {
    h.state.conv = {
      assignedAgentId: null,
      aiAutoreplyDisabled: false,
      aiReplyCount: 0,
      isGroup: true,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.sqlCalls).toHaveLength(0)
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assignedAgentId: 'agent-9',
      aiAutoreplyDisabled: false,
      aiReplyCount: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assignedAgentId: null,
      aiAutoreplyDisabled: true,
      aiReplyCount: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached (mesmo episódio)', async () => {
    h.state.conv = {
      assignedAgentId: null,
      aiAutoreplyDisabled: false,
      aiReplyCount: 3,
    }
    // A IA falou HÁ POUCO → mesmo episódio → o teto vale. O mock devolve esta
    // mesma linha pro guard anti-eco (que lê senderType) e pra checagem de
    // episódio (que lê createdAt).
    h.state.lastMessages = [{ senderType: 'customer', createdAt: new Date().toISOString() }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('teto batido mas IA calada há horas = episódio novo: zera e responde (caso 05/09)', async () => {
    // 05/09: cliente recorrente, conversa aberta desde 26/08, 22 respostas.
    // O teto por vida da conversa calava a IA a cada ~3 pedidos, no meio da
    // venda. Agora um silêncio de horas reabre o episódio.
    h.state.conv = {
      assignedAgentId: null,
      aiAutoreplyDisabled: false,
      aiReplyCount: 3,
    }
    const cincoHorasAtras = new Date(Date.now() - 5 * 3_600_000).toISOString()
    h.state.lastMessages = [{ senderType: 'customer', createdAt: cincoHorasAtras }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toEqual(expect.objectContaining({ aiReplyCount: 0 }))
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — transferência por etiqueta (16/09, Gás do Povo)', () => {
  const comHandoff = () => h.loadAiConfig.mockResolvedValue(aiConfig({ tools: ['handoff'] } as Partial<AiConfig>))

  it('só o marcador, sem despedida → manda a despedida padrão e transfere', async () => {
    comHandoff()
    h.generateReply.mockResolvedValue({ text: '[[TRANSFERIR:Responsável|Carla, CPF 12345678909, entrega]]', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect((h.engineSendText.mock.calls[0][0] as { text: string }).text).toContain('responsável')
    expect(h.applyTransfer).toHaveBeenCalledWith(expect.objectContaining({ tagName: 'Responsável', summary: 'Carla, CPF 12345678909, entrega' }))
  })

  it('despedida + marcador com "]" no resumo → o cliente recebe só a despedida', async () => {
    comHandoff()
    h.generateReply.mockResolvedValue({
      text: 'Perfeito! Já passo pro responsável 😊\n[[TRANSFERIR:Responsável|Carla [Gás do Povo], CPF 12345678909]]',
      handoff: false,
    })
    await dispatchInboundToAiReply(ARGS)
    const enviados = h.engineSendText.mock.calls.map((c) => (c[0] as { text: string }).text).join('\n')
    expect(enviados).toContain('Já passo pro responsável')
    expect(enviados).not.toContain('12345678909')
    expect(h.applyTransfer).toHaveBeenCalled()
  })

  it('sem vaga no limite → não responde, mas transfere', async () => {
    comHandoff()
    h.state.claim = false
    h.generateReply.mockResolvedValue({ text: 'Já passo pro responsável 😊\n[[TRANSFERIR:Responsável|Carla]]', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.applyTransfer).toHaveBeenCalled()
  })

  it('[[IGNORAR]] junto de [[TRANSFERIR]] → a transferência ganha', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ tools: ['handoff', 'skip_reply'] } as Partial<AiConfig>))
    h.generateReply.mockResolvedValue({ text: '[[IGNORAR]]\n[[TRANSFERIR:Responsável|Carla]]', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.applyTransfer).toHaveBeenCalled()
  })

  it('marcador que ninguém reconhece nunca vai pro cliente', async () => {
    h.generateReply.mockResolvedValue({ text: 'Oi! Tudo certo 😊 [[XPTO:cpf 12345678909]]', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    const enviados = h.engineSendText.mock.calls.map((c) => (c[0] as { text: string }).text).join('\n')
    expect(enviados).toContain('Oi! Tudo certo')
    expect(enviados).not.toContain('XPTO')
  })
})

describe('dispatchInboundToAiReply — marcador de cobrança [[COBRANCA:]] (16/09)', () => {
  const DIVIDA = '- R$ 325,00, venceu em 10/09/2026'
  const enviados = () => h.engineSendText.mock.calls.map((c) => (c[0] as { text: string }).text).join('\n')
  const decisao = (decision: Record<string, unknown>) => h.evaluateCollectionMarker.mockResolvedValue({ decision, relevance: 'direct' })

  it('sem dívida aberta: nem passa pela trava, não mexe na régua e o marcador não vai pro cliente', async () => {
    h.generateReply.mockResolvedValue({ text: 'Vou passar pra quem decide 😊 [[COBRANCA:acordo]]', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.evaluateCollectionMarker).not.toHaveBeenCalled()
    expect(h.applyCollectionReply).not.toHaveBeenCalled()
    expect(enviados()).toContain('Vou passar pra quem decide')
    expect(enviados()).not.toContain('COBRANCA')
  })

  it('trava falhou: a resposta sai e o marcador é ignorado (nada na régua)', async () => {
    h.openDebtForPrompt.mockResolvedValue(DIVIDA)
    h.evaluateCollectionMarker.mockRejectedValue(new Error('banco fora'))
    h.generateReply.mockResolvedValue({ text: 'Combinado, sexta! [[COBRANCA:promessa|2026-09-18]]', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(enviados()).toContain('Combinado, sexta!')
    expect(enviados()).not.toContain('COBRANCA')
    expect(h.applyCollectionReply).not.toHaveBeenCalled()
    expect(h.postInternalNote).not.toHaveBeenCalled()
  })

  it('a trava decide ANTES do envio (depois dele a rajada do cliente some da leitura)', async () => {
    h.openDebtForPrompt.mockResolvedValue(DIVIDA)
    decisao({ action: 'skip', reason: 'modelo: nenhum' })
    h.generateReply.mockResolvedValue({ text: 'Combinado, sexta! [[COBRANCA:promessa|2026-09-18]]', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.evaluateCollectionMarker).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-1', contactId: 'contact-1', kind: 'promessa', date: '2026-09-18' }))
    expect(h.evaluateCollectionMarker.mock.invocationCallOrder[0]).toBeLessThan(h.engineSendText.mock.invocationCallOrder[0])
  })

  it('skip: sem nota e sem régua', async () => {
    h.openDebtForPrompt.mockResolvedValue(DIVIDA)
    decisao({ action: 'skip', reason: 'fora de contexto de cobrança' })
    h.generateReply.mockResolvedValue({ text: 'Entendi! [[COBRANCA:comprovante]]', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
    expect(h.applyCollectionReply).not.toHaveBeenCalled()
    expect(h.postInternalNote).not.toHaveBeenCalled()
  })

  it('note: uma nota só (a trava de nota repetida manda), régua intacta', async () => {
    h.openDebtForPrompt.mockResolvedValue(DIVIDA)
    const text = '🧾 O cliente falou em pagar, mas sem data que desse para calcular.'
    decisao({ action: 'note', kind: 'promessa', text, relevance: 'direct' })
    h.generateReply.mockResolvedValue({ text: 'Tudo bem! [[COBRANCA:promessa]]', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.applyCollectionReply).not.toHaveBeenCalled()
    expect(h.postInternalNote).toHaveBeenCalledTimes(1)
    expect(h.postInternalNote).toHaveBeenCalledWith({ conversationId: 'conv-1', text })

    h.postInternalNote.mockClear()
    h.claimReplyNote.mockResolvedValue(false)
    await dispatchInboundToAiReply(ARGS)
    expect(h.postInternalNote).not.toHaveBeenCalled()
  })

  it('apply: aplica com as opções que a trava decidiu e registra a nota do resultado', async () => {
    h.openDebtForPrompt.mockResolvedValue(DIVIDA)
    decisao({ action: 'apply', kind: 'promessa', date: '2026-09-18', pause: false, moveDueDate: true, relevance: 'direct' })
    h.applyCollectionReply.mockResolvedValue({ applied: true, note: '🧾 Cliente prometeu pagar em 18/09/2026.' })
    h.generateReply.mockResolvedValue({ text: 'Combinado, sexta! [[COBRANCA:promessa|2026-09-18]]', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.applyCollectionReply).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-1', contactId: 'contact-1', conversationId: 'conv-1', kind: 'promessa', date: '2026-09-18' }),
      expect.objectContaining({ moveDueDate: true, pause: false, maxPromiseDays: 45, countSiblings: true }),
    )
    expect(h.postInternalNote).toHaveBeenCalledWith({ conversationId: 'conv-1', text: '🧾 Cliente prometeu pagar em 18/09/2026.' })
    expect(enviados()).not.toContain('COBRANCA')
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('handoff sem texto: manda despedida padrão e desliga a IA', async () => {
    // Bug da 1ª transferência da Maria (26/08): o cliente ficava no vácuo.
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    const sent = h.engineSendText.mock.calls[0][0] as { text: string }
    expect(sent.text).toContain('responsável')
    expect(h.state.updatePayload).toEqual({ aiAutoreplyDisabled: true })
    expect(h.state.sqlCalls).toHaveLength(0)
  })

  it('handoff COM texto: envia a despedida do modelo e desliga a IA', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Perfeito! O responsável já vai falar contigo.',
      handoff: true,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Perfeito! O responsável já vai falar contigo.',
      }),
    )
    expect(h.state.updatePayload).toEqual({ aiAutoreplyDisabled: true })
  })
})

// 🙋 29/09 (reunião, caso Zelo): a IA transferiu, o dono marcou a reunião à mão
// pelo WhatsApp e o card nunca andou — o [[HANDOFF]] desligava a IA de vez. Com
// pausa configurada ela fica quieta N min e volta; perda, troca de funil e a 2ª
// transferência em 24h continuam desligando.
describe('dispatchInboundToAiReply — pausa ao pedir um humano', () => {
  const comPausa = (min = 30, extra: Partial<AiConfig> = {}) =>
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffPauseMinutes: min, ...extra }))
  /** Texto da nota "A IA pediu um humano" (a 1ª linha decide pausa × desliga). */
  const notaDoHandoff = () =>
    (h.postInternalNote.mock.calls as [{ text: string }][])
      .map((c) => c[0].text)
      .find((t) => t.startsWith(HANDOFF_NOTE_PREFIX))
  const pausouPor = (min: number) => {
    expect(h.state.updatePayload).not.toBeNull()
    expect(Object.keys(h.state.updatePayload!)).toEqual(['aiPausedUntil'])
    // now() + make_interval(mins => N): o N vai como parâmetro do SQL.
    expect(h.safeStringify(h.state.updatePayload!.aiPausedUntil)).toContain('make_interval')
    expect(h.safeStringify(h.state.updatePayload!.aiPausedUntil)).toContain(String(min))
  }

  it('com pausa configurada: NÃO desliga — pausa, nota com o prefixo idêntico e aviso ao dono dizendo que volta', async () => {
    comPausa(30)
    h.generateReply.mockResolvedValue({ text: 'Perfeito! O responsável já vai falar contigo.', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Perfeito! O responsável já vai falar contigo.' }),
    )
    pausouPor(30)
    expect(h.state.updatePayload).not.toHaveProperty('aiAutoreplyDisabled')
    const nota = notaDoHandoff()
    expect(nota?.split('\n')[0]).toBe(
      `${HANDOFF_NOTE_PREFIX} — IA pausada por 30 min (volta sozinha se a pessoa escrever e ninguém responder)`,
    )
    expect(h.sendOwnerAlert).toHaveBeenCalledWith(
      'acct-1',
      'handoff',
      expect.objectContaining({ motivo: expect.stringContaining('pausada por 30 min') }),
    )
  })

  it('handoff SEM texto com pausa: despedida padrão e pausa', async () => {
    comPausa(15)
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    pausouPor(15)
  })

  it('2ª transferência em 24h → desliga de vez (anti-laço), payload antigo e o porquê na nota', async () => {
    comPausa(30)
    h.state.priorHandoffs = 1
    h.generateReply.mockResolvedValue({ text: 'Já chamo alguém!', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toEqual({ aiAutoreplyDisabled: true })
    expect(notaDoHandoff()?.split('\n')[0]).toContain('2ª transferência em 24h')
    expect(h.sendOwnerAlert).toHaveBeenCalledWith(
      'acct-1',
      'handoff',
      expect.objectContaining({ motivo: expect.stringContaining('desligada') }),
    )
  })

  it('contagem de transferências falhou → segue como 1ª (pausa) e não derruba a transferência', async () => {
    comPausa(30)
    h.state.countThrows = true
    h.generateReply.mockResolvedValue({ text: 'Já chamo alguém!', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    pausouPor(30)
    expect(h.sendOwnerAlert).toHaveBeenCalled()
  })

  it('[[PERDER]] junto do handoff → desliga, e o comentário da perda vai pro encerramento', async () => {
    comPausa(30, { tools: ['move_card'] } as Partial<AiConfig>)
    const text = 'Entendi, vou passar pra equipe.\n[[PERDER:Sem orçamento | só ano que vem]]'
    h.generateReply.mockResolvedValue({ text, handoff: true })
    await dispatchInboundToAiReply(ARGS)
    // O que o parser devolver (contrato do [[PERDER:motivo | comentário]]) é
    // repassado tal e qual: motivo em loseReason, comentário em loseNote.
    const lose = parseCloseDirectives(text).lose
    expect(h.applyCloseActions).toHaveBeenCalledWith(
      expect.objectContaining({
        resolve: false,
        loseReason: lose?.reason,
        loseNote: (lose as { note?: string } | null)?.note ?? null,
      }),
    )
    expect(h.state.updatePayload).toEqual({ aiAutoreplyDisabled: true })
    expect(notaDoHandoff()?.split('\n')[0]).toContain('marcado como perdido')
  })

  it('card foi pra OUTRO funil sem ganho (lead de serviço/emprego) → desliga', async () => {
    comPausa(30, { tools: ['move_funnel'] } as Partial<AiConfig>)
    h.applyCloseActions.mockResolvedValue({ resolved: false, movedTo: 'Novo', movedToFunnel: 'Serviços', lost: false, changedFunnel: true })
    h.generateReply.mockResolvedValue({ text: 'Vou te passar pro time certo.\n[[FUNIL:Serviços > Novo]]', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toEqual({ aiAutoreplyDisabled: true })
    expect(notaDoHandoff()?.split('\n')[0]).toContain('outro funil')
  })

  it('"[[FUNIL:<funil atual> > etapa]]" só troca a ETAPA → pausa (não é outro funil)', async () => {
    comPausa(30, { tools: ['move_funnel'] } as Partial<AiConfig>)
    h.applyCloseActions.mockResolvedValue({ resolved: false, movedTo: 'Qualificado', movedToFunnel: 'Vendas', lost: false, changedFunnel: false })
    h.generateReply.mockResolvedValue({ text: 'Já chamo alguém!\n[[FUNIL:Vendas > Qualificado]]', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    pausouPor(30)
  })

  it('outro funil COM ganho (lead qualificado indo pra venda) → pausa', async () => {
    comPausa(30, { tools: ['move_funnel'] } as Partial<AiConfig>)
    h.applyCloseActions.mockResolvedValue({
      resolved: false,
      movedTo: 'Reunião',
      movedToFunnel: 'Vendas',
      lost: false,
      won: true,
      spawnedDealId: 'deal-2',
    })
    h.generateReply.mockResolvedValue({ text: 'Show! Já chamo o consultor.\n[[GANHO]]\n[[FUNIL:Vendas > Reunião]]', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    pausouPor(30)
  })

  it('encerramento lançou → a transferência sai mesmo assim (antes a IA ficava ligada e o dono sem aviso)', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ tools: ['move_card'] } as Partial<AiConfig>))
    h.applyCloseActions.mockRejectedValue(new Error('banco fora'))
    h.generateReply.mockResolvedValue({ text: 'Já chamo alguém!\n[[FUNIL:Qualificado]]', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toEqual({ aiAutoreplyDisabled: true })
    expect(h.sendOwnerAlert).toHaveBeenCalled()
  })

  it('sem pausa (padrão 0): nota exatamente como antes e nenhuma contagem extra', async () => {
    h.generateReply.mockResolvedValue({ text: 'Já chamo alguém!', handoff: true })
    h.state.priorHandoffs = 5 // ignorado: sem pausa nem conta
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toEqual({ aiAutoreplyDisabled: true })
    expect(notaDoHandoff()?.split('\n')[0]).toBe(HANDOFF_NOTE_PREFIX)
    expect(h.sendOwnerAlert).toHaveBeenCalledWith(
      'acct-1',
      'handoff',
      expect.objectContaining({ motivo: 'A IA pediu um humano nesta conversa' }),
    )
  })

  it('gate: pausa vigente → não gera, não desliga e reagenda pro FIM da pausa', async () => {
    h.state.conv = { ...(h.state.conv as object), aiPausedUntil: new Date(Date.now() + 10 * 60_000).toISOString() }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
    expect(h.enqueueRecheck).toHaveBeenCalledTimes(1)
    const delay = h.enqueueRecheck.mock.calls[0][1] as number
    expect(delay).toBeGreaterThan(9 * 60_000)
    expect(delay).toBeLessThan(11 * 60_000)
  })

  it('gate: pausa vencida → responde normalmente', async () => {
    h.state.conv = { ...(h.state.conv as object), aiPausedUntil: new Date(Date.now() - 60_000).toISOString() }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
    expect(h.enqueueRecheck).not.toHaveBeenCalled()
  })

  it('contexto: transferência nas últimas 24h → o prompt diz que a equipe foi avisada e não recomeça a qualificação', async () => {
    comPausa(60)
    h.state.handoffNotes = [{ handoffAt: new Date(Date.now() - 40 * 60_000).toISOString() }]
    await dispatchInboundToAiReply(ARGS)
    const prompt = (h.generateReply.mock.calls[0][0] as { systemPrompt: string }).systemPrompt
    expect(prompt).toContain('HANDED OFF TO A HUMAN')
    expect(prompt).toContain('Do NOT restart the qualification')
  })

  it('contexto: agente SEM pausa (padrão) → nada muda no prompt, mesmo com transferência recente', async () => {
    h.state.handoffNotes = [{ handoffAt: new Date(Date.now() - 40 * 60_000).toISOString() }]
    await dispatchInboundToAiReply(ARGS)
    const prompt = (h.generateReply.mock.calls[0][0] as { systemPrompt: string }).systemPrompt
    expect(prompt).not.toContain('HANDED OFF TO A HUMAN')
  })

  it('contexto: sem transferência recente → prompt sem a instrução', async () => {
    await dispatchInboundToAiReply(ARGS)
    const prompt = (h.generateReply.mock.calls[0][0] as { systemPrompt: string }).systemPrompt
    expect(prompt).not.toContain('HANDED OFF TO A HUMAN')
  })
})

// 📅 Revisão de 02/10 — agendar.
describe('dispatchInboundToAiReply — [[AGENDAR]] com aprovação (Precisa de você)', () => {
  const comAprovacao = () =>
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ tools: ['schedule'], autonomy: { actions: { schedule_event: 'approve' } } } as Partial<AiConfig>),
    )
  const notas = () => h.postInternalNote.mock.calls.map((c) => (c[0] as { text: string }).text)

  it('entrou na fila: o pedido vai SEM duração fixa (mover mantém a da consulta) e o dono é chamado para aprovar', async () => {
    comAprovacao()
    h.state.insertReturning = [{ id: 'req-1' }]
    h.generateReply.mockResolvedValue({
      text: 'Vou confirmar esse horário e já te retorno!\n[[AGENDAR:2026-10-23T10:00|Avaliação · Bianca|Dr. Otávio|nova]]',
      handoff: false,
    })
    await dispatchInboundToAiReply(ARGS)

    expect(h.state.inserts).toHaveLength(1)
    const payload = h.state.inserts[0].payload as Record<string, unknown>
    expect(payload).toMatchObject({
      startsLocal: '2026-10-23T10:00',
      title: 'Avaliação · Bianca',
      profissional: 'Dr. Otávio',
      modo: { tipo: 'nova' },
    })
    expect(payload).not.toHaveProperty('durationMin')
    expect(notas().some((t) => t.includes('aguardando sua aprovação'))).toBe(true)
    expect(h.notifyUsers).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approval_required', title: 'Aprovar: marcar "Avaliação · Bianca"' }),
    )
  })

  it('já havia OUTRO pedido pendente (outro horário): este NÃO foi registrado — a nota diz e o dono é avisado', async () => {
    // A mãe combinou a consulta do segundo filho com o primeiro pedido ainda
    // na fila: o índice único descartava este sem ninguém saber.
    comAprovacao()
    h.state.insertReturning = []
    h.state.pendingSchedule = [{ payload: { startsLocal: '2026-10-21T09:30', title: 'Avaliação · Davi' } }]
    h.generateReply.mockResolvedValue({
      text: 'Vou confirmar e te retorno!\n[[AGENDAR:2026-10-23T10:00|Avaliação · Bianca||nova]]',
      handoff: false,
    })
    await dispatchInboundToAiReply(ARGS)

    const nota = notas().find((t) => t.includes('NÃO foi registrado'))
    expect(nota).toContain(
      'o agendamento de "Avaliação · Bianca" para 23/10 às 10:00 NÃO foi registrado porque já há um pedido pendente',
    )
    expect(nota).toContain('"Avaliação · Davi" para 21/10 às 09:30')
    expect(h.notifyUsers).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approval_required', title: 'NÃO registrado: marcar "Avaliação · Bianca"' }),
    )
  })

  it('"nova" no MESMO horário de um pendente diferente (dois filhos, duas cadeiras): também avisa', async () => {
    comAprovacao()
    h.state.pendingSchedule = [
      { payload: { startsLocal: '2026-10-23T10:00', title: 'Avaliação · Davi', profissional: 'Dra. Marta' } },
    ]
    h.generateReply.mockResolvedValue({
      text: 'Vou confirmar!\n[[AGENDAR:2026-10-23T10:00|Avaliação · Bianca|Dr. Otávio|nova]]',
      handoff: false,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(notas().some((t) => t.includes('NÃO foi registrado'))).toBe(true)
    expect(h.notifyUsers).toHaveBeenCalledTimes(1)
  })

  it('o MESMO pedido repetido (marcador em turnos seguidos): só a nota de sempre, sem aviso', async () => {
    comAprovacao()
    h.state.pendingSchedule = [
      { payload: { startsLocal: '2026-10-23T10:00', title: 'Avaliação · Bianca', profissional: 'Dr. Otávio' } },
    ]
    h.generateReply.mockResolvedValue({
      text: 'Vou confirmar!\n[[AGENDAR:2026-10-23T10:00|Avaliação  Bianca|Dr. Otávio|nova]]',
      handoff: false,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(notas().some((t) => t.includes('já havia um pedido pendente deste contato'))).toBe(true)
    expect(notas().some((t) => t.includes('NÃO foi registrado'))).toBe(false)
    expect(h.notifyUsers).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — [[AGENDAR]] que não mexeu em nada', () => {
  it('sem dizer nova/remarcação com duas consultas: nota na conversa e aviso ao dono com o porquê', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ tools: ['schedule'] } as Partial<AiConfig>))
    h.scheduleEventFromAi.mockResolvedValue({
      naoAchou: true,
      motivo: 'sem-modo',
      deLocal: null,
      startsLocal: '2026-10-23T10:00',
      titulo: 'Avaliação · Bianca',
      consultas: 2,
    })
    h.generateReply.mockResolvedValue({ text: 'Marquei!\n[[AGENDAR:2026-10-23T10:00|Avaliação · Bianca]]', handoff: false })
    await dispatchInboundToAiReply(ARGS)

    const nota = h.postInternalNote.mock.calls
      .map((c) => (c[0] as { text: string }).text)
      .find((t) => t.startsWith('📅'))
    expect(nota).toContain(
      'sem dizer se era consulta nova ou remarcação; o contato tem 2 consultas marcadas — nada foi alterado',
    )
    expect(h.notifyUsers).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agent_action', title: 'IA não marcou: faltou dizer se era consulta nova ou remarcação' }),
    )
  })

  it('remarcou: o aviso ao dono diz de quem é a consulta e o que ficou no horário antigo', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ tools: ['schedule'] } as Partial<AiConfig>))
    h.scheduleEventFromAi.mockResolvedValue({
      eventId: 'ev-davi',
      startsAt: '2026-10-23T13:00:00.000Z',
      title: 'Avaliação · Davi',
      tituloAntigo: 'Avaliação · Davi',
      tituloDaIa: 'Avaliação · Bianca',
      acao: 'moveu',
      rescheduled: true,
      movidoDe: '2026-10-21T12:30:00.000Z',
      ficouNoHorarioAntigo: [
        { startsAt: '2026-10-21T12:30:00.000Z', agenda: 'Dr. Otávio Prates', titulo: 'Avaliação · Davi' },
      ],
    })
    h.generateReply.mockResolvedValue({ text: 'Remarquei!\n[[AGENDAR:2026-10-23T10:00|Avaliação · Bianca]]', handoff: false })
    await dispatchInboundToAiReply(ARGS)

    const aviso = h.notifyUsers.mock.calls[0][0] as { title: string; body: string }
    expect(aviso.title).toBe('IA remarcou: Avaliação · Davi')
    expect(aviso.body).toContain('a IA a chamou de "Avaliação · Bianca"')
    expect(aviso.body).toContain('⚠️ Ficou outra consulta deste contato')
  })
})
