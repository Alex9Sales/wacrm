import { describe, expect, it } from 'vitest'

import {
  MANUAL_COLLECT_KIND,
  daysLateOn,
  defaultManualCollectChannelId,
  hasOverdueOpenCharge,
  isOverdueOpenCharge,
  manualCollectChannelLabel,
  manualCollectExpireReason,
  manualCollectExpiresKind,
  manualCollectRequestValues,
  manualCollectSuccessMessage,
  manualHoldReason,
  momentLabel,
  signManualCollectText,
  type ManualCollectChannel,
} from './manual-send-rules'
import { countsAsCollectionTouch, debtorHold } from './rules'

const JOAO = 'u-joao'
const VITOR = 'u-vitor'

const canal = (id: string, p: Partial<ManualCollectChannel> = {}): ManualCollectChannel => ({
  id,
  name: id,
  dedicated_user_id: null,
  dedicated_user_name: null,
  status: 'connected',
  ...p,
})

// 22/09 (João/GoLink): o João cobra pelo número dele, o Vitor pelo dele.
describe('defaultManualCollectChannelId — meu número → sem dono → régua', () => {
  const regua = 'cobrancas'
  const canais = [
    canal('atendimento'),
    canal('joao', { dedicated_user_id: JOAO, dedicated_user_name: 'João' }),
    canal('vitor', { dedicated_user_id: VITOR, dedicated_user_name: 'Vitor' }),
    canal(regua, { dedicated_user_id: 'u-leonardo', dedicated_user_name: 'Leonardo' }),
  ]

  it('quem tem número próprio começa nele', () => {
    expect(defaultManualCollectChannelId(canais, JOAO, regua)).toBe('joao')
    expect(defaultManualCollectChannelId(canais, VITOR, regua)).toBe('vitor')
  })

  it('sem número próprio, o número de ninguém vem antes do número de outra pessoa', () => {
    expect(defaultManualCollectChannelId(canais, 'u-ana', regua)).toBe('atendimento')
  })

  it('entre os números de ninguém, o da régua vem primeiro', () => {
    const livres = [canal('atendimento'), canal('cobrancas')]
    expect(defaultManualCollectChannelId(livres, 'u-ana', 'cobrancas')).toBe('cobrancas')
    expect(defaultManualCollectChannelId(livres, 'u-ana', null)).toBe('atendimento')
  })

  it('só com números de outras pessoas, cai no da régua', () => {
    const soDeOutros = canais.filter((c) => c.id !== 'atendimento')
    expect(defaultManualCollectChannelId(soDeOutros, 'u-ana', regua)).toBe(regua)
  })

  it('número desconectado não é escolhido, nem sendo o meu', () => {
    const caido = [canal('joao', { dedicated_user_id: JOAO, status: 'disconnected' }), canal('atendimento')]
    expect(defaultManualCollectChannelId(caido, JOAO, null)).toBe('atendimento')
    expect(defaultManualCollectChannelId([canal('x', { status: 'disconnected' })], JOAO, null)).toBeNull()
  })
})

describe('manualCollectChannelLabel', () => {
  it('diz de quem é o número', () => {
    expect(manualCollectChannelLabel(canal('Cobranças', { dedicated_user_id: JOAO }), JOAO)).toBe('Cobranças (seu número)')
    expect(manualCollectChannelLabel(canal('Vitor', { dedicated_user_id: VITOR, dedicated_user_name: 'Vitor' }), JOAO)).toBe('Vitor (número de Vitor)')
    expect(manualCollectChannelLabel(canal('Atendimento'), JOAO)).toBe('Atendimento')
  })
})

// Mesma regra do envio pelo inbox: assina quem CLICOU, nunca em código/link.
describe('signManualCollectText', () => {
  const texto = 'Oi, Paulo! Ficou um valor em aberto por aqui.'

  it('assina com o nome de quem clica quando a conta pede assinatura', () => {
    expect(signManualCollectText(texto, 'João', true)).toBe(`*João:*\n${texto}`)
  })

  it('sem a opção da conta, ou sem nome, sai limpo', () => {
    expect(signManualCollectText(texto, 'João', false)).toBe(texto)
    expect(signManualCollectText(texto, '  ', true)).toBe(texto)
    expect(signManualCollectText(texto, null, true)).toBe(texto)
  })

  it('link ou código sozinho nunca leva assinatura (looksLikeBareCode)', () => {
    expect(signManualCollectText('https://www.asaas.com/i/abc123', 'João', true)).toBe('https://www.asaas.com/i/abc123')
    const boleto = '23793.38128 60000.000003 00000.000400 1 84340000010000'
    expect(signManualCollectText(boleto, 'João', true)).toBe(boleto)
  })
})

// O envio à mão CONTA como toque; lembrete e aviso de cobrança nova não.
describe('toque da régua por tipo de envio', () => {
  it("kind 'manual' conta, 'reminder' e 'new_charge' não, cobrança da régua (sem kind) conta", () => {
    expect(countsAsCollectionTouch(MANUAL_COLLECT_KIND)).toBe(true)
    expect(countsAsCollectionTouch(undefined)).toBe(true)
    expect(countsAsCollectionTouch('reminder')).toBe(false)
    expect(countsAsCollectionTouch('new_charge')).toBe(false)
  })

  it('o envio à mão expira só a cobrança da régua pendente, não o lembrete nem o aviso', () => {
    expect(manualCollectExpiresKind(undefined)).toBe(true)
    expect(manualCollectExpiresKind(MANUAL_COLLECT_KIND)).toBe(true)
    expect(manualCollectExpiresKind('reminder')).toBe(false)
    expect(manualCollectExpiresKind('new_charge')).toBe(false)
  })
})

// Reconferência antes de enviar: open=true sozinho não basta (parcela a
// vencer também fica aberta na carteira).
describe('isOverdueOpenCharge / hasOverdueOpenCharge', () => {
  const hoje = '2026-09-22'

  it('venceu antes de hoje = vencida', () => {
    expect(isOverdueOpenCharge({ open: true, dueDate: '2026-09-21' }, hoje)).toBe(true)
    expect(isOverdueOpenCharge({ open: true, dueDate: '2026-01-05' }, hoje)).toBe(true)
  })

  it('vence hoje ou depois NÃO é vencida', () => {
    expect(isOverdueOpenCharge({ open: true, dueDate: '2026-09-22' }, hoje)).toBe(false)
    expect(isOverdueOpenCharge({ open: true, dueDate: '2026-09-25' }, hoje)).toBe(false)
  })

  it('sem data conhecida continua entrando; fechada nunca', () => {
    expect(isOverdueOpenCharge({ open: true, dueDate: null }, hoje)).toBe(true)
    expect(isOverdueOpenCharge({ open: false, dueDate: '2026-09-01' }, hoje)).toBe(false)
  })

  it('basta UMA vencida em aberto', () => {
    expect(hasOverdueOpenCharge([{ open: true, dueDate: '2026-09-30' }, { open: true, dueDate: '2026-09-10' }], hoje)).toBe(true)
    expect(hasOverdueOpenCharge([{ open: true, dueDate: '2026-09-30' }, { open: false, dueDate: '2026-09-10' }], hoje)).toBe(false)
    expect(hasOverdueOpenCharge([], hoje)).toBe(false)
  })

  it('daysLateOn conta por DATA no fuso da conta, como a régua', () => {
    expect(daysLateOn('2026-09-21', hoje)).toBe(1)
    expect(daysLateOn('2026-09-10', hoje)).toBe(12)
    expect(daysLateOn('2026-09-22', hoje)).toBe(0)
    expect(daysLateOn('2026-09-25', hoje)).toBe(-3)
    expect(daysLateOn(null, hoje)).toBeNull()
    expect(daysLateOn('lixo', hoje)).toBeNull()
  })
})

describe('manualHoldReason — o freio como o diálogo mostra', () => {
  const agora = new Date('2026-09-22T12:00:00-03:00')

  it('pausado: motivo entre parênteses', () => {
    const st = { lastTouchAt: null, touchCount: 2, snoozeUntil: null, paused: true, pausedReason: 'acordo em andamento' }
    expect(manualHoldReason(debtorHold(st, null, agora), st)).toBe('Este cliente está marcado como "não cobrar" (acordo em andamento).')
  })

  it('promessa: data no fuso da conta e motivo', () => {
    const st = { lastTouchAt: null, touchCount: 1, snoozeUntil: '2026-09-30T03:00:00.000Z', paused: false, snoozeReason: 'pago dia 29' }
    expect(manualHoldReason(debtorHold(st, null, agora), st)).toBe('Este cliente prometeu pagar até 30/09 (pago dia 29) — a régua está dormindo nele.')
  })

  it('sem freio, nada', () => {
    const st = { lastTouchAt: null, touchCount: 0, snoozeUntil: '2026-09-01T03:00:00.000Z', paused: false }
    expect(manualHoldReason(debtorHold(st, null, agora), st)).toBeNull()
    expect(manualHoldReason(null, {})).toBeNull()
  })
})

describe('momentLabel', () => {
  it('dia da semana + período, como a régua', () => {
    expect(momentLabel(9, 5)).toBe('sexta-feira de manhã')
    expect(momentLabel(15, 1)).toBe('segunda-feira à tarde')
    expect(momentLabel(19, 0)).toBe('domingo à noite')
    expect(momentLabel(9, -1)).toBe('')
  })
})

describe('manualCollectRequestValues — o pedido já nasce enviado', () => {
  const v = manualCollectRequestValues({
    accountId: 'acc',
    contactId: 'c1',
    conversationId: 'conv1',
    channelId: 'joao',
    byUserId: JOAO,
    touch: 3,
    text: 'Oi, Paulo!',
    lines: ['R$ 100,00 · venceu em 10/09/2026 (12 dias de atraso)'],
    links: ['https://www.asaas.com/i/abc'],
    now: '2026-09-22T15:00:00.000Z',
  })

  it("é um collect_charges 'sent' com kind manual (o painel Envios da régua lê por action_type)", () => {
    expect(v.actionType).toBe('collect_charges')
    expect(v.status).toBe('sent')
    expect(v.payload.kind).toBe('manual')
    expect(v.payload.sentBy).toBe('wallet')
    expect(v.payload.touch).toBe(3)
    expect(v.payload.channelId).toBe('joao')
    expect(v.payload.byUserId).toBe(JOAO)
    expect(v.payload.delivery).toBe('whatsapp')
  })

  it('executado e resolvido agora, por quem clicou, com a conversa no resultado', () => {
    expect(v.executedAt).toBe('2026-09-22T15:00:00.000Z')
    expect(v.resolvedAt).toBe('2026-09-22T15:00:00.000Z')
    expect(v.resolvedBy).toBe(JOAO)
    expect(v.conversationId).toBe('conv1')
    expect(v.result).toEqual({ conversationId: 'conv1', sentVia: ['whatsapp'], label: 'WhatsApp' })
    expect(v.decision).toBe('suggest')
    expect(v.suggestedText).toBe('Oi, Paulo!')
  })
})

describe('textos', () => {
  it('motivo da expiração diz quem cobrou à mão', () => {
    expect(manualCollectExpireReason('João')).toBe('Cobrado à mão por João; o pedido automático foi cancelado.')
    expect(manualCollectExpireReason(null)).toBe('Cobrado à mão por uma pessoa da equipe; o pedido automático foi cancelado.')
  })

  it('toast de sucesso com o rótulo do número e o nº do toque', () => {
    expect(manualCollectSuccessMessage('Cobranças (seu número)', 2)).toBe('Cobrança enviada pelo Cobranças (seu número) · contou como toque Nº 2')
  })
})
