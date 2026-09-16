// ============================================================
// Texto dos avisos pro WhatsApp do dono — PURO (worker e client podem usar).
//
// 16/09 (Família do Gás, caso Gisele): o aviso "IA TRANSFERIU PRA HUMANO"
// levou no resumo o texto cru das falas — a localização da cliente com quebra
// de linha no meio, fala de áudio cortada no meio da palavra ("só que até a")
// e o nome do contato "." ("👤 . · 5567…"). No CRM, o link do Maps ainda fez a
// bolha inteira virar cartão de mapa (corrigido em inbox/location-message.ts).
//
// Regras:
//   • cada fala do cliente vira UMA linha; quebra dentro da fala vira " / "
//     (entre falas o separador é " · ", pra dar pra saber onde uma termina);
//   • localização vira "📍 localização: <link>" — link INTEIRO (coordenada
//     cortada = pino errado; é justamente o que o dono precisa pra achar);
//   • mídia vira rótulo curto; áudio mostra a transcrição;
//   • corte em limite de palavra (e de grafema — emoji não parte), com "…";
//   • estourou o total → sai a fala mais ANTIGA (a mais nova explica o pedido);
//   • nome sem nenhuma letra ("." "..." "🙂" "ㅤ") não é nome → só o telefone.
// ============================================================

import { CALL_LOG_PREFIX, CALL_PERM_PREFIX } from '@/lib/inbox/call-log'
import { detectLocationMessage } from '@/lib/inbox/location-message'
import { PIX_PREFIX } from '@/lib/whatsapp/pix'

/** Separador entre falas no resumo. */
export const TAIL_SEPARATOR = ' · '

const AUDIO_KINDS = new Set(['audio', 'voice', 'ptt'])
const MEDIA_LABELS: Record<string, string> = {
  image: '📷 mandou uma foto',
  video: '🎥 mandou um vídeo',
  document: '📄 mandou um documento',
  sticker: '🎟️ mandou uma figurinha',
  location: '📍 mandou a localização',
  contact: '👤 mandou um contato',
}

/** Caracteres "em branco" que o WhatsApp aceita como nome (Hangul filler,
 *  braille vazio, zero-width…). \p{L} considera alguns deles LETRA. */
// U+200C/U+200D (ZWNJ/ZWJ) ficam de fora: fazem parte de emoji composto.
const NAME_FILLER_RE = /[\u115F\u1160\u3164\uFFA0\u2800\u200B\u200E\u200F\u2060-\u2064\uFEFF]/g

function graphemes(s: string): string[] {
  try {
    return Array.from(new Intl.Segmenter('pt', { granularity: 'grapheme' }).segment(s), (x) => x.segment)
  } catch {
    return Array.from(s)
  }
}

/** Uma linha só: quebras viram " / ", espaços repetidos viram um. */
export function oneLine(input: string | null | undefined): string {
  return (input ?? '')
    .replace(/[ \t]*(?:\r?\n[ \t]*)+/g, ' / ')
    .replace(/\s+/g, ' ')
    .replace(/^(?: \/ )+|(?: \/ )+$/g, '')
    .trim()
}

/** Corta em `max` grafemas, no último espaço (se não voltar mais que metade),
 *  sem deixar link pela metade, com "…" no fim. */
export function clipAtWord(input: string, max: number): string {
  const s = input.trim()
  const g = graphemes(s)
  if (g.length <= max) return s
  let cut = g.slice(0, Math.max(1, max - 1)).join('')
  // A última palavra ficou pela metade? (Corte caiu antes de espaço, ou voltou
  // até um espaço = palavra inteira.)
  let partial = !/\s/.test(g[max - 1] ?? ' ')
  if (partial) {
    const sp = cut.lastIndexOf(' ')
    if (sp >= Math.floor(cut.length / 2)) {
      cut = cut.slice(0, sp)
      partial = false
    }
  }
  const tokens = cut.split(/(\s+)/)
  const last = tokens[tokens.length - 1] ?? ''
  const lastIsUrl = /^https?:\/\//i.test(last)
  // Link CORTADO não serve (um pino cortado aponta pro lugar errado): some o
  // pedaço inteiro, inclusive "htt"/"https:/". Link inteiro fica.
  if (partial && (lastIsUrl || (last.length >= 3 && 'https://'.startsWith(last.toLowerCase())))) {
    tokens.pop()
    cut = tokens.join('').replace(/[\s,.;:·/—–-]+$/u, '')
    return cut ? `${cut}…` : ''
  }
  // Link inteiro no fim: espaço antes do "…" (senão o WhatsApp puxa pro link).
  if (lastIsUrl) return `${cut.trimEnd()} …`
  cut = cut.replace(/[\s,.;:·/—–-]+$/u, '')
  return cut ? `${cut}…` : ''
}

export interface TailMessage {
  contentType: string | null
  contentText: string | null
  transcription: string | null
}

/** Uma fala do cliente numa linha curta pro aviso. '' = não entra no resumo. */
export function summarizeClientMessage(m: TailMessage, perItem = 140): string {
  const kind = (m.contentType ?? 'text').toLowerCase()
  const text = (m.contentText ?? '').trim()

  if (AUDIO_KINDS.has(kind)) {
    const said = clipAtWord(oneLine(m.transcription), perItem - 3)
    return said ? `🎤 ${said}` : '🎤 mandou um áudio'
  }
  if (kind !== 'text') return MEDIA_LABELS[kind] ?? ''

  if (!text || text.startsWith(CALL_PERM_PREFIX)) return ''
  if (text.startsWith(CALL_LOG_PREFIX)) return '📞 ligação'
  if (text.startsWith(PIX_PREFIX)) return '💠 mandou uma chave Pix'
  const loc = detectLocationMessage(text)
  if (loc) return `📍 localização: ${loc.url}`
  const placeholder = /^\[([a-z]+)\]$/i.exec(text)
  if (placeholder) return MEDIA_LABELS[placeholder[1].toLowerCase()] ?? ''
  // Fala que é só um link comprido demais não some do resumo.
  return clipAtWord(oneLine(text), perItem) || '🔗 mandou um link'
}

/** Resumo "o que o cliente disse" com as últimas falas (mais antiga primeiro). */
export function buildClientTail(
  messages: ReadonlyArray<TailMessage>,
  opts: { maxItems?: number; perItem?: number; maxTotal?: number } = {},
): string {
  const { maxItems = 4, perItem = 140, maxTotal = 420 } = opts
  const items: string[] = []
  for (const m of messages) {
    const t = summarizeClientMessage(m, perItem)
    if (t && t !== items[items.length - 1]) items.push(t)
  }
  const recent = items.slice(-maxItems)
  const kept: string[] = []
  let size = 0
  for (let i = recent.length - 1; i >= 0; i--) {
    const add = graphemes(recent[i]).length + (kept.length ? TAIL_SEPARATOR.length : 0)
    if (kept.length && size + add > maxTotal) break
    kept.unshift(kept.length ? recent[i] : clipAtWord(recent[i], maxTotal))
    size += add
  }
  return kept.join(TAIL_SEPARATOR)
}

/** Nome do contato apresentável no aviso — '' quando não é nome de verdade. */
export function alertContactName(name: string | null | undefined, phone?: string | null): string {
  const n = (name ?? '')
    .replace(NAME_FILLER_RE, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s*_~`]+|[\s*_~`]+$/g, '')
    .trim()
  if (!/\p{L}/u.test(n)) return ''
  const digits = n.replace(/\D/g, '')
  if (/^\+?[\d\s().-]+$/.test(n) || (phone && digits.length >= 8 && digits === phone.replace(/\D/g, ''))) return ''
  return clipAtWord(n, 60)
}

/** Resumo livre (do modelo) numa linha, com teto. */
export function oneLineSummary(input: string | null | undefined, max = 400): string {
  return clipAtWord(oneLine(input), max)
}
