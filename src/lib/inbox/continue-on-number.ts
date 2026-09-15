// ============================================================
// ↪️ "Continuar pelo meu número" — regras e textos puros.
//
// 15/09 (Alex, caso Will Santos/GoLink): o cliente escreveu pro número do
// Vitor, a conversa foi transferida pro João, e tudo que o João respondia
// saía pelo WhatsApp do Vitor. Transferir NÃO troca de número — e é o certo:
// os números são da empresa. Este botão é uma ESCOLHA de quem atende: abre a
// conversa com o mesmo cliente no número da pessoa, e o contexto vai junto:
//   - pra quem atende: nota com as últimas mensagens na conversa nova, aviso
//     na antiga e o vínculo entre as duas (migr 0170, botão no topo);
//   - pro cliente: a 1ª mensagem vem pronta no compositor, pra revisar;
//   - pra IA: o histórico do contato em outros números já entra no prompt.
//
// Emoji ↪️, NUNCA 🔀: nota começando com "🔀 " cai no filtro do aviso de outro
// canal (cross-channel.ts) e o silencia por 12 h.
//
// Puro (client-safe).
// ============================================================

import { formatPhone } from '@/lib/format-phone'

const WHATSAPP = new Set(['meta', 'waha', 'evolution', 'evogo'])

export function isWhatsAppProvider(provider: string | null | undefined): boolean {
  return !!provider && WHATSAPP.has(provider)
}

/** Últimas falas da conversa de origem que entram na nota. */
export const CONTINUATION_MAX_LINES = 10
const MAX_CHARS_PER_LINE = 220

export interface MyNumber {
  id: string
  name: string
  phone: string | null
  provider: string
}

/** Números de WhatsApp CONECTADOS dedicados a esta pessoa. */
export function myWhatsAppNumbers<T extends { provider: string; status: string; dedicatedUserId: string | null }>(
  channels: T[],
  userId: string,
): T[] {
  return channels.filter((c) => WHATSAPP.has(c.provider) && c.status === 'connected' && c.dedicatedUserId === userId)
}

export interface TranscriptRow {
  senderType: string
  contentType: string
  contentText: string | null
  transcription: string | null
  createdAt: string | null
}

const MIDIA: Record<string, string> = {
  image: 'imagem',
  audio: 'áudio',
  video: 'vídeo',
  document: 'documento',
  sticker: 'figurinha',
  location: 'localização',
}

function quando(iso: string | null, tz: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d)
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? ''
  return `${v('day')}/${v('month')} ${v('hour')}:${v('minute')}`
}

/**
 * "[14/09 17:42] Cliente: preciso conectar a tag…" — em ordem, as últimas
 * CONTINUATION_MAX_LINES falas que têm conteúdo. Recebe em ordem cronológica.
 */
export function transcriptLines(rows: TranscriptRow[], tz: string): string[] {
  const linhas: string[] = []
  for (const r of rows) {
    const quem = r.senderType === 'customer' ? 'Cliente' : 'Atendimento'
    const texto = (r.contentText ?? '').trim()
    const placeholder = /^\[[a-z_]+\]$/i.test(texto)
    let corpo = ''
    if (r.contentType === 'text' || (texto && !placeholder)) {
      corpo = texto
    }
    if (r.contentType !== 'text') {
      const rotulo = `[${MIDIA[r.contentType] ?? r.contentType}]`
      const extra = (r.transcription ?? '').trim()
      corpo = [rotulo, corpo && !placeholder ? corpo : '', extra].filter(Boolean).join(' ')
    }
    corpo = corpo.replace(/\s+/g, ' ').trim()
    if (!corpo) continue
    if (Array.from(corpo).length > MAX_CHARS_PER_LINE) corpo = `${Array.from(corpo).slice(0, MAX_CHARS_PER_LINE).join('')}…`
    linhas.push(`[${quando(r.createdAt, tz)}] ${quem}: ${corpo}`)
  }
  return linhas.slice(-CONTINUATION_MAX_LINES)
}

function numero(nome: string, telefone: string | null): string {
  const fone = telefone && telefone.replace(/\D/g, '') ? formatPhone(telefone) : null
  return fone ? `${nome} (${fone})` : nome
}

/** Nota interna na conversa NOVA (no número de quem continuou). */
export function noteForNewConversation(input: {
  fromChannelName: string
  fromPhone: string | null
  byName: string
  at: string
  tz: string
  lines: string[]
  /** Origem privada: as falas NÃO vêm (a conversa nova é lida por mais gente). */
  privateSource?: boolean
}): string {
  const topo = `↪️ Continuação do atendimento que começou no número ${numero(input.fromChannelName, input.fromPhone)}, trazido pra cá por ${input.byName} em ${quando(input.at, input.tz)}.`
  const meio = input.privateSource
    ? 'A conversa de lá é privada: as mensagens não foram copiadas pra cá.'
    : input.lines.length
      ? `Últimas mensagens de lá:\n${input.lines.join('\n')}`
      : 'A conversa de lá não tinha mensagens de texto.'
  return `${topo}\n\n${meio}\n\nA conversa inteira continua no outro número (botão "Ver conversa anterior" no topo, pra quem tem acesso a ela).`
}

/** Nota interna na conversa ANTIGA (número de onde o atendimento saiu). */
export function noteForOldConversation(input: {
  toChannelName: string
  toPhone: string | null
  byName: string
  at: string
  tz: string
  /** A IA e o follow-up desta conversa foram desligados (estava sem responsável). */
  aiPaused?: boolean
}): string {
  return (
    `↪️ ${input.byName} continuou este atendimento pelo número ${numero(input.toChannelName, input.toPhone)} em ${quando(input.at, input.tz)}. ` +
    `Se o cliente escrever aqui de novo, avise ${input.byName}: o que for respondido nesta conversa sai por este número.` +
    (input.aiPaused ? ' A IA desta conversa foi desligada pra não responder em paralelo.' : '')
  )
}

/** 1ª mensagem pro cliente, pronta no compositor — a pessoa revisa antes de enviar. */
export function continuationDraft(userName: string | null | undefined): string {
  const nome = (userName ?? '').trim().split(/\s+/)[0]
  return nome
    ? `Oi! Aqui é ${nome}. Vou continuar seu atendimento por este número, tudo bem?`
    : 'Oi! Vou continuar seu atendimento por este número, tudo bem?'
}
