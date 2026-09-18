import { describe, expect, it } from 'vitest'

import {
  CONTINUATION_MAX_LINES,
  continuationDraft,
  myWhatsAppNumbers,
  noteForNewConversation,
  noteForOldConversation,
  transcriptLines,
  type TranscriptRow,
} from './continue-on-number'

const TZ = 'America/Sao_Paulo'
const JOAO = 'u-joao'

// 15/09 (Alex): caso de um cliente da GoLink — escreveu pro número do Vitor, a conversa foi
// transferida pro João, e as respostas do João saíam pelo WhatsApp do Vitor.
describe('myWhatsAppNumbers', () => {
  const canais = [
    { id: 'vitor', provider: 'waha', status: 'connected', dedicatedUserId: 'u-vitor' },
    { id: 'joao', provider: 'waha', status: 'connected', dedicatedUserId: JOAO },
    { id: 'cobrancas', provider: 'waha', status: 'connected', dedicatedUserId: JOAO },
    { id: 'joao-caido', provider: 'waha', status: 'disconnected', dedicatedUserId: JOAO },
    { id: 'gmail', provider: 'gmail', status: 'connected', dedicatedUserId: JOAO },
    { id: 'atendimento', provider: 'waha', status: 'connected', dedicatedUserId: null },
  ]

  it('só números de WhatsApp conectados e dedicados à pessoa', () => {
    expect(myWhatsAppNumbers(canais, JOAO).map((c) => c.id)).toEqual(['joao', 'cobrancas'])
  })

  it('quem não tem número dedicado não tem "meu número"', () => {
    expect(myWhatsAppNumbers(canais, 'u-leonardo')).toEqual([])
  })
})

describe('transcriptLines', () => {
  const row = (senderType: string, createdAt: string, contentText: string | null, extra: Partial<TranscriptRow> = {}): TranscriptRow => ({
    senderType,
    contentType: 'text',
    contentText,
    transcription: null,
    createdAt,
    ...extra,
  })

  it('rotula quem falou e põe data e hora no fuso da conta', () => {
    const linhas = transcriptLines(
      [
        row('customer', '2026-09-14T19:52:37Z', 'Sou Paulo da Oficina Modelo'),
        row('agent', '2026-09-14T20:43:31Z', 'Vou transferir esse chat para o João.'),
      ],
      TZ,
    )
    expect(linhas).toEqual(['[14/09 16:52] Cliente: Sou Paulo da Oficina Modelo', '[14/09 17:43] Atendimento: Vou transferir esse chat para o João.'])
  })

  it('mídia vira rótulo + descrição, sem o marcador cru', () => {
    const [audio, foto] = transcriptLines(
      [
        row('customer', '2026-09-14T19:00:00Z', '[audio]', { contentType: 'audio', transcription: 'quero a tag no site' }),
        row('customer', '2026-09-14T19:01:00Z', 'Moto preta', { contentType: 'image', transcription: 'Comprovante de R$ 936,13' }),
      ],
      TZ,
    )
    expect(audio).toBe('[14/09 16:00] Cliente: [áudio] quero a tag no site')
    expect(foto).toBe('[14/09 16:01] Cliente: [imagem] Moto preta Comprovante de R$ 936,13')
  })

  it('pula fala vazia, corta texto longo e fica só com as últimas', () => {
    const muitas = Array.from({ length: CONTINUATION_MAX_LINES + 5 }, (_, i) =>
      row('customer', `2026-09-14T19:${String(i).padStart(2, '0')}:00Z`, i === 3 ? '   ' : `msg ${i} ${'x'.repeat(300)}`),
    )
    const linhas = transcriptLines(muitas, TZ)
    expect(linhas).toHaveLength(CONTINUATION_MAX_LINES)
    expect(linhas.at(-1)).toMatch(/^\[14\/09 16:14\] Cliente: msg 14 x+…$/)
    expect(linhas.every((l) => !l.includes('msg 3 '))).toBe(true)
  })
})

describe('notas e rascunho', () => {
  const at = '2026-09-15T04:30:00Z'

  it('nota da conversa nova diz de onde veio, quem trouxe e as últimas falas', () => {
    const nota = noteForNewConversation({
      fromChannelName: 'Vitor',
      fromPhone: '5512990001234',
      byName: 'João',
      at,
      tz: TZ,
      lines: ['[14/09 16:52] Cliente: Sou Paulo da Oficina Modelo'],
    })
    expect(nota.startsWith('↪️ Continuação do atendimento que começou no número Vitor (+55 12 99000-1234), trazido pra cá por João em 15/09 01:30.')).toBe(true)
    expect(nota).toContain('Últimas mensagens de lá:\n[14/09 16:52] Cliente: Sou Paulo da Oficina Modelo')
    expect(nota).toContain('Ver conversa anterior')
  })

  it('nota da conversa antiga avisa por onde o atendimento seguiu', () => {
    const nota = noteForOldConversation({ toChannelName: 'João', toPhone: '5512990005678', byName: 'João', at, tz: TZ })
    expect(nota).toBe(
      '↪️ João continuou este atendimento pelo número João (+55 12 99000-5678) em 15/09 01:30. Se o cliente escrever aqui de novo, avise João: o que for respondido nesta conversa sai por este número.',
    )
  })

  it('nenhuma nota começa com 🔀 (silenciaria o aviso de outro canal)', () => {
    const nova = noteForNewConversation({ fromChannelName: 'Vitor', fromPhone: null, byName: 'João', at, tz: TZ, lines: [] })
    const antiga = noteForOldConversation({ toChannelName: 'João', toPhone: null, byName: 'João', at, tz: TZ })
    expect(nova.startsWith('🔀')).toBe(false)
    expect(antiga.startsWith('🔀')).toBe(false)
    expect(nova).toContain('não tinha mensagens de texto')
  })

  it('origem privada: a nota não copia as falas (revisão 15/09)', () => {
    const nota = noteForNewConversation({
      fromChannelName: 'Vitor',
      fromPhone: null,
      byName: 'João',
      at,
      tz: TZ,
      lines: ['[14/09 16:52] Cliente: segredo'],
      privateSource: true,
    })
    expect(nota).not.toContain('segredo')
    expect(nota).toContain('é privada: as mensagens não foram copiadas')
  })

  it('conversa antiga sem responsável avisa que a IA foi desligada', () => {
    const nota = noteForOldConversation({ toChannelName: 'João', toPhone: null, byName: 'João', at, tz: TZ, aiPaused: true })
    expect(nota.endsWith('A IA desta conversa foi desligada pra não responder em paralelo.')).toBe(true)
  })

  it('rascunho usa só o primeiro nome de quem continua', () => {
    expect(continuationDraft('João Pedro Silva')).toBe('Oi! Aqui é João. Vou continuar seu atendimento por este número, tudo bem?')
    expect(continuationDraft('')).toBe('Oi! Vou continuar seu atendimento por este número, tudo bem?')
  })
})
