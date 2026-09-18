// ============================================================
// 🧾 Trava da resposta de cobrança — PURO (sem banco, testável).
//
// 16/09 (GoLink): o detector silencioso marcou promessa → acordo (pausa) →
// comprovante numa conversa da Ótica Exemplo sobre RECARGA do Google Ads, no
// canal Atendimento, 3 a 5 dias depois da última cobrança (que saiu por outro
// canal). "Fazemos amanhã então" virou promessa, "Quanto é o mínimo ?" virou
// acordo e o Pix de R$ 150 para o Google virou comprovante da parcela de
// R$ 325. No mesmo dia a KB Transportes ("se puder esperar até sexta")
// virou ACORDO e parou a régua sem prazo; na conta Fluxia, uma conversa
// pessoal do Bruno TX sobre entregas rendeu 6 marcações.
//
// O modelo continua dando o palpite, mas quem decide é o código:
//   1. a fala tem de estar num CONTEXTO de cobrança (relevância) — sem isso
//      nem chamamos o modelo;
//   2. o regex só VETA ou REBAIXA o que o modelo disse, nunca promove;
//   3. pausa (acordo) só em resposta DIRETA à cobrança; fora disso vira nota;
//   4. comprovante com valor que não bate com o que está aberto não mexe na
//      régua;
//   5. o mesmo efeito já aplicado não se repete (Loja 77: rajada lida 2x em 9 s).
//
// Os limites (7 d, 5 respostas, 48 h, 72 h, 10 %, 45 d) foram calibrados com
// as 25 marcações reais de 09/09 a 16/09 — ficam como constantes exportadas.
//
// Sem 'server-only' e sem @/db: roda no worker, na auto-resposta e nos testes.
// ============================================================

import { neutralizeUntrusted } from '@/lib/ai/untrusted'

import { isAiPause } from './pause-rules'
import type { CollectionReplyKind } from './reply'

// ---------------------------------------------------------------- limites

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** Cobrança NESTA conversa vale como resposta direta por até 7 dias… */
export const DIRECT_WINDOW_MS = 7 * DAY_MS
/** …se a conversa não andou: até 5 respostas nossas depois dela (Lúcia: 4;
 *  Bruno TX: 78 a 177 mensagens sobre entregas depois do link de teste).
 *  Conta TURNOS, não balões — ver countOurTurns. */
export const DIRECT_MAX_OUTBOUND = 5
/** Nas primeiras 24 h a cobrança da conversa vale mesmo com conversa andando. */
export const DIRECT_FRESH_MS = DAY_MS
/** Cobrança em QUALQUER conversa do contato (o cliente responde por outro
 *  número): Jorge Teste 4 h e Clínica Modelo 46 h entram; Ótica Exemplo,
 *  76 h ou mais, fica de fora. */
export const RECENT_COLLECTION_MS = 48 * HOUR_MS
/** "Nós perguntamos da dívida" sem link (Leonardo Financeiro: "Consegue fazer
 *  a parcela de hoje?") — a última mensagem nossa da conversa, até 7 dias. */
export const ASKED_DEBT_WINDOW_MS = 7 * DAY_MS
/** O cliente puxa o pagamento sem mensagem nossa na conversa há 72 h (Casa Aurora). */
export const SPONTANEOUS_QUIET_MS = 72 * HOUR_MS
/** Pix de terceiro que NÓS mandamos (Google) nas 24 h antes do comprovante. */
export const OTHER_PIX_WINDOW_MS = DAY_MS
/** Promessa para mais de 45 dias não segura a régua: "pago no vencimento" de
 *  uma parcela A VENCER adiaria a cobrança da vencida por semanas. */
export const MAX_PROMISE_DAYS = 45
/** Encargos aceitos acima do valor (ou os juros do Asaas, se forem maiores):
 *  Jorge Teste pagou 170,93 por 165 (3,6 %); a PR Pisos mandou 200 ao Google
 *  contra 180 (11 %). */
export const RECEIPT_TOLERANCE_RATIO = 0.1
/** Folga de arredondamento, em reais. */
export const RECEIPT_TOLERANCE_ABS = 1
/** Até quantas parcelas entram na soma ("acerte pelo menos três"). */
export const RECEIPT_MAX_CHARGES = 10
/** Rajada do cliente: até 6 balões, no máximo 3 h antes do mais novo. Jorge
 *  Teste 14/09: um "👍" de 11/09 colado na imagem do comprovante mudava a âncora. */
export const BURST_MAX_BUBBLES = 6
export const BURST_MAX_SPAN_MS = 3 * HOUR_MS
/** Comprovante igual dentro de 12 h é a mesma rajada lida de novo. */
export const RECEIPT_DEDUP_MS = 12 * HOUR_MS
/** Nota igual (mesmo tipo e texto) na mesma conversa dentro de 12 h não se repete. */
export const NOTE_DEDUP_MS = 12 * HOUR_MS

// ---------------------------------------------------------------- motivos gravados na régua

export const RECEIPT_SNOOZE_REASON = 'Cliente mandou comprovante — aguardando conferência'
export const ACORDO_PAUSE_REASON = 'Cliente pediu acordo/parcelamento'
export const CONTESTA_PAUSE_REASON = 'Cliente contesta a cobrança'

/** "2026-09-18" → "18/09/2026". */
export const brDate = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/')
export const promiseSnoozeReason = (date: string) => `Cliente prometeu pagar em ${brDate(date)}`
/** Motivo que due-date.ts grava ao mover o vencimento no Asaas (a régua acorda no mesmo instante da promessa). */
export const dueDateMovedReason = (date: string) => `Vencimento alterado para ${brDate(date)}`
/** Começo do motivo que a "Registrar promessa" da tela grava ("… — registrado por João: obs"). */
export const manualPromiseReasonPrefix = (date: string) => `Prometeu pagar em ${brDate(date)}`

// ---------------------------------------------------------------- palavras
// \b do JS não respeita acento ("simão" casaria "sim"): início e fim de
// palavra por letra/número Unicode. Sem fim de palavra, "pagode" casava
// "pago", "acordou" casava "acordo" e "dividendo" casava "divide".

const B = '(?<![\\p{L}\\p{N}])'
const E = '(?![\\p{L}\\p{N}])'
const W = (s: string) => new RegExp(`${B}(?:${s})${E}`, 'iu')

export const DEBT_WORD_RE = W('boletos?|faturas?|parcelas?|mensalidades?|cobran[çc]as?|d[ée]bitos?|d[íi]vidas?|em aberto|atrasad[oa]s?|vencid[oa]s?|juros|asaas|pend[êe]ncias?')
/** Sem "vencido": "domínio vencido" aparece nas conversas da GoLink e não é cobrança. */
export const ASKED_DEBT_RE = W('boletos?|faturas?|parcelas?|mensalidades?|cobran[çc]as?|d[ée]bitos?|em aberto|pend[êe]ncias?')
// 16/09 (revisão): como estes regex VETAM o palpite do modelo, forma que falta
// derruba caso certo — "Vou transferir agora o de vocês" (Clínica Modelo) virava
// "promessa sem falar em pagar", e "vou depositar amanhã" não contava como fala
// espontânea de pagamento.
export const PAY_WORD_RE = W(
  'pag(?:a|as|am|ar|arei|aria|aremos|arem|amos|ando|amento|amentos|o|ou|ue|uem|uei|[áa]-?l[oa])|psgar|pgar|pix|transfer(?:ir|i|o|imos|[êe]ncia)|deposit(?:ar|o|amos|ei)|comprovante|quit(?:ar|o|ei)|acert(?:ar|o|amos)|efetu(?:ar|o|ei)',
)
export const NEGOTIATION_RE = W('parcel(?:ar|amento|ad[oa]|inha)|em \\d+ ?(?:x|vezes)|\\d+ ?x|divid(?:ir|e|imos)|desconto|descontinho|abat(?:er|imento)|(?:re)?negoci\\p{L}*|acordo|reduz(?:ir|ido|a)?|diminuir|abaixar|baixar o valor|valor menor|metade|fica bom pra|faz(?:er)? por|tirar (?:os )?juros|sem (?:os )?juros|isen(?:tar|[çc][ãa]o)|o resto|restante|uma parte|entrada')
export const CONTEST_RE = W(
  'n[ãa]o devo|n[ãa]o reconhe[çc]\\p{L}*|cancelei|cancelad[oa]|n[ãa]o contratei|nunca contratei|n[ãa]o pedi|n[ãa]o (?:solicitei|autorizei|fiz (?:esse|essa|este|esta) (?:pedido|compra))|cobran[çc]a (?:errad|indevid)\\p{L}*|valor errado|est[áa] errad[oa]|n[ãa]o [ée] (?:meu|minha|nosso|nossa)|engano',
)
export const PAID_CLAIM_RE = W('j[áa] (?:paguei|pago|foi pag[oa]|quitei|est[áa] pag[oa]|fiz o pix|transferi)|paguei|t[áa] pag[oa]|segue (?:o )?comprovante|fiz o pix|pix feito')

/** Pix copia-e-cola que NÃO é do Asaas (Ótica Exemplo 16/09: o atendente mandou o Pix do Google). */
export const isOtherPix = (t: string) => /br\.gov\.bcb\.pix/i.test(t) && !/asaas/i.test(t)

// ---------------------------------------------------------------- rajada do cliente

export interface BurstRow {
  id: string
  senderType: string
  contentText: string | null
  transcription: string | null
  contentType: string | null
  createdAt: string | null
}

export interface CustomerBurst {
  /** Balões do cliente, do mais velho para o mais novo. */
  bubbles: BurstRow[]
  newestId: string
  /** Âncora de TODAS as buscas: o balão mais novo, nunca o primeiro. */
  newestAt: Date
  /** O que ele escreveu ou falou (texto, legenda da mídia e transcrição de áudio) — SEM descrição de imagem. */
  typed: string
  /** Descrição de imagem/documento (visão). */
  media: string
}

/** Placeholder de mídia sem transcrição ("[audio]", "[image]") não classifica. */
const PLACEHOLDER_RE = /^\[[a-z]+\]$/i

const isReceiptMedia = (contentType: string | null) => contentType === 'image' || contentType === 'document'
const mediaLabel = (contentType: string | null) => (contentType === 'document' ? 'documento' : 'imagem')

type BubbleContent = { contentText: string | null; transcription: string | null; contentType: string | null }

/**
 * O que um balão traz, separado em fala e descrição de mídia.
 *
 * 16/09 (revisão): o inbound grava a DESCRIÇÃO da imagem ou do documento em
 * `transcription` (describeImage/describeDocument em channels/inbound.ts) e
 * deixa em contentText a legenda ou "[image]". Lendo a transcrição antes do
 * tipo, todo comprovante descrito caía na fala e a mídia ficava vazia em
 * produção: a conferência de valor nunca rodava e o Pix de R$ 150 ao Google
 * (Ótica Exemplo) virava comprovante da parcela de R$ 325 — os testes punham a
 * descrição em contentText e não pegavam. Numa imagem ou documento: descrição
 * → mídia; legenda ("segue comprovante") → fala. A data impressa no
 * comprovante ("pago em 16/09") também deixa de virar data de promessa.
 */
function bubbleParts(row: BubbleContent): { typed: string; media: string } {
  const t = (row.transcription ?? '').trim()
  const c = (row.contentText ?? '').trim()
  const caption = c && !PLACEHOLDER_RE.test(c) ? c : ''
  if (isReceiptMedia(row.contentType)) return { typed: caption, media: t }
  return { typed: t || caption, media: '' }
}

/**
 * Texto que o cliente mandou num balão: a transcrição do áudio, o texto, e numa
 * imagem ou documento a descrição da IA ("[imagem: transferência de R$ 400]")
 * seguida da legenda. Mesma regra do pickBurst (bubbleParts).
 */
export function customerTextOf(row: BubbleContent): string {
  const { typed, media } = bubbleParts(row)
  return [media ? `[${mediaLabel(row.contentType)}: ${media}]` : '', typed].filter(Boolean).join('\n')
}

const toMs = (v: string | Date | null | undefined): number => {
  if (!v) return NaN
  return v instanceof Date ? v.getTime() : new Date(v).getTime()
}

/**
 * A rajada: balões do cliente seguidos, a partir do mais novo. Para no
 * primeiro balão que não é dele OU que é mais de 3 h mais velho que o mais
 * novo. `rowsNewestFirst` = mensagens não internas, da mais nova para a mais
 * velha. Sem balão do cliente no topo → null.
 */
export function pickBurst(
  rowsNewestFirst: BurstRow[],
  opts: { maxBubbles?: number; maxSpanMs?: number } = {},
): CustomerBurst | null {
  const maxBubbles = opts.maxBubbles ?? BURST_MAX_BUBBLES
  const maxSpanMs = opts.maxSpanMs ?? BURST_MAX_SPAN_MS
  const newest = rowsNewestFirst[0]
  if (!newest || newest.senderType !== 'customer') return null
  const newestMs = toMs(newest.createdAt)
  if (!Number.isFinite(newestMs)) return null

  const picked: BurstRow[] = []
  for (const r of rowsNewestFirst) {
    if (r.senderType !== 'customer') break
    const at = toMs(r.createdAt)
    if (!Number.isFinite(at) || newestMs - at > maxSpanMs) break
    picked.push(r)
    if (picked.length >= maxBubbles) break
  }
  const bubbles = picked.reverse()

  const typed: string[] = []
  const media: string[] = []
  for (const b of bubbles) {
    const parts = bubbleParts(b)
    if (parts.media) media.push(parts.media)
    if (parts.typed) typed.push(parts.typed)
  }
  return { bubbles, newestId: newest.id, newestAt: new Date(newestMs), typed: typed.join('\n'), media: media.join('\n') }
}

/**
 * Rajada para o marcador [[COBRANCA:]] da IA que conversa: pula as partes da
 * NOSSA resposta anterior que saíram depois da fala do cliente.
 *
 * 16/09 (revisão): a IA responde em partes, com "digitando…" entre elas. Se o
 * cliente escreve "pago sexta" durante a parte 2, as partes 2 e 3 (bot) ficam
 * mais novas que ele; a rechecagem de corrida responde com
 * [[COBRANCA:promessa|…]] e o pickBurst puro via "bot por último" → sem rajada
 * → marcador descartado. A IA confirmava a data e a régua seguia cobrando.
 * Só 'bot' é pulado: 'agent' é gente no meio, e aí a IA nem responde.
 */
export function pickMarkerBurst(rowsNewestFirst: BurstRow[], opts: { maxBubbles?: number; maxSpanMs?: number } = {}): CustomerBurst | null {
  let i = 0
  while (i < rowsNewestFirst.length && rowsNewestFirst[i].senderType === 'bot') i++
  return pickBurst(rowsNewestFirst.slice(i), opts)
}

// ---------------------------------------------------------------- relevância

export type Relevance = 'direct' | 'recent_collection' | 'asked_debt' | 'mentions_debt' | 'amount_match' | 'spontaneous_payment'

export interface OurMessage {
  at: Date
  text: string
}

export interface OpenCharge {
  value: number
  interestValue: number | null
}

export interface ReplyGuardContext {
  newestAt: Date
  typed: string
  media: string
  /** Última mensagem nossa com link de cobrança NESTA conversa (7 d antes de newestAt). */
  sameConvCollectAt: Date | null
  /** Respostas nossas nesta conversa depois dela (e antes de newestAt), em turnos (countOurTurns). */
  outboundSinceCollect: number
  /** Última mensagem nossa com link de cobrança em QUALQUER conversa do contato. */
  anyCollectAt: Date | null
  /** Mensagens nossas nesta conversa nas 72 h antes de newestAt. */
  outboundLast72h: number
  /** Últimas mensagens nossas nesta conversa antes da rajada, da mais nova para a mais velha. */
  ourRecent: OurMessage[]
  /** Parcelas abertas do contato e dos cadastros irmãos (mesmo cliente do Asaas). */
  openCharges: OpenCharge[]
}

/** Nós mandamos um Pix que não é do Asaas pouco antes? (o comprovante é dele) */
export function otherPixWithin(ours: OurMessage[], newestAt: Date, windowMs = OTHER_PIX_WINDOW_MS): boolean {
  const t = newestAt.getTime()
  return ours.some((m) => t - m.at.getTime() <= windowMs && isOtherPix(m.text))
}

/**
 * Quantas RESPOSTAS nossas há numa sequência de mensagens (qualquer ordem
 * entre turnos; cliente incluído só para separar os turnos): cada mensagem de
 * pessoa ('agent') conta 1; balões seguidos da IA ('bot') contam 1.
 *
 * 16/09 (revisão): a IA manda até 4 balões por resposta (splitIntoMessages) e
 * cada um contava como mensagem — dois turnos da IA passavam do limite de 5 e
 * a própria conversa da cobrança deixava de ser "direct": "sexta" virava
 * promessa descartada e "dá pra parcelar em 3x?" só nota, com a IA já tendo
 * confirmado a data ao cliente. 'bot' continua contando (a IA falando de outro
 * assunto dias depois do link não pode valer como resposta direta por 7 dias).
 */
export function countOurTurns(rows: { senderType: string }[]): number {
  let turns = 0
  let inBotBlock = false
  for (const r of rows) {
    if (r.senderType === 'bot') {
      if (!inBotBlock) turns++
      inBotBlock = true
    } else {
      if (r.senderType === 'agent') turns++
      inBotBlock = false
    }
  }
  return turns
}

/**
 * A fala do cliente está num contexto de cobrança? null = não, e nem vale
 * chamar o modelo. Todas as buscas são ANTES do balão mais novo.
 *
 * 16/09 (revisão): "nós perguntamos da dívida" vem ANTES de "cobrança recente
 * em qualquer conversa". Na ordem antiga, o "consigo sexta" do Leonardo com a
 * régua tendo mandado link por outro número 30 h antes caía em
 * recent_collection e a promessa era descartada; com 54 h, aplicava — quanto
 * mais recente a cobrança, pior.
 */
export function collectionReplyRelevance(c: ReplyGuardContext): Relevance | null {
  const t = c.newestAt.getTime()
  const ago = (d: Date | null | undefined) => (d ? t - d.getTime() : Infinity)

  const sinceSame = ago(c.sameConvCollectAt)
  if (sinceSame <= DIRECT_WINDOW_MS && (c.outboundSinceCollect <= DIRECT_MAX_OUTBOUND || sinceSame <= DIRECT_FRESH_MS)) return 'direct'
  const lastOurs = c.ourRecent[0]
  if (lastOurs && ago(lastOurs.at) <= ASKED_DEBT_WINDOW_MS && ASKED_DEBT_RE.test(lastOurs.text)) return 'asked_debt'
  if (ago(c.anyCollectAt) <= RECENT_COLLECTION_MS) return 'recent_collection'
  if (DEBT_WORD_RE.test(c.typed)) return 'mentions_debt'
  const amounts = amountsIn(c.media)
  if (amounts.length && amountMatchesOpen(amounts, c.openCharges) && !otherPixWithin(c.ourRecent, c.newestAt)) return 'amount_match'
  if (c.outboundLast72h === 0 && (PAY_WORD_RE.test(c.typed) || PAID_CLAIM_RE.test(c.typed))) return 'spontaneous_payment'
  return null
}

// ---------------------------------------------------------------- datas em português

const pad2 = (n: number) => String(n).padStart(2, '0')
const keyOf = (d: Date) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`

function utcFromKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return keyOf(d) === key ? d : null
}

/** Data válida (31/09 não existe) em UTC, ou null. */
function validUtc(y: number, month: number, day: number): Date | null {
  const d = new Date(Date.UTC(y, month - 1, day))
  return d.getUTCFullYear() === y && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS)

/** "YYYY-MM-DD" + n dias. */
export function addDaysKey(key: string, n: number): string {
  const d = utcFromKey(key)
  return d ? keyOf(addDays(d, n)) : key
}

const WEEKDAY_INDEX: Record<string, number> = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 }
const MONTH_INDEX: Record<string, number> = {
  janeiro: 1,
  fevereiro: 2,
  marco: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
}
const stripAccents = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '')

// Um regex só, para os tokens saírem na ORDEM em que aparecem no texto.
// Dia da semana seguido de parcela/via/vez/etapa não é data ("segunda via do
// boleto", "segunda parcela").
//
// 16/09 (revisão): o leitor VENCE o modelo quando os dois discordam, então
// data lida pela metade é pior que nenhuma. "dia 25 de outubro" virava 25/09 e
// zerava a promessa de 25/10 do modelo; "dia 20 do mês que vem" virava 20/09 e,
// sem data do modelo, gravava a promessa um mês antes. Agora "dia N de <mês>" e
// "dia N do mês que vem" calculam o mês; "sexta que vem" e "sexta da semana
// que vem" não emitem token (o modelo decide). O `(?![- ]feira)` impede o
// regex de recuar e aceitar só "sexta" em "sexta-feira que vem".
//
// 16/09 (revisão 2): o mês dito ANTES do dia era ignorado — "mês q vem dia
// 20", "só no outro mês, dia 20", "outubro dia 20" e até "segurar até o mês
// que vem dia 20" viravam 20/09. No detector silencioso, com acordo sem data
// do modelo (caso KB), a promessa ia para 20/09 e o vencimento no Asaas
// também; no marcador, a IA confirmava 20/10 e o leitor vetava. "semana que
// vem na sexta" e "sexta, semana que vem" viravam a sexta DESTA semana. Agora:
// "q vem" = "que vem"; mês antes do dia conta; "semana que vem" + dia da
// semana, em qualquer ordem, não emite token. A trava continua LOCAL (colada
// ao dia): "Pago 1 na sexta feira / Beleza / O resto semana que vem"
// (Loja 77) segue sendo 18/09.
const QV = 'q(?:ue)?\\s+vem'
const NEXT_MONTH = `m[êe]s\\s+${QV}|pr[óo]ximo\\s+m[êe]s|outro\\s+m[êe]s`
const NEXT_WEEK = `semana\\s+${QV}|pr[óo]xima\\s+semana|outra\\s+semana`
const MONTHS = 'janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro'
const WEEKDAYS = 'domingo|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado'
// Grupos: 1 mês antes do dia · 2 "mês que vem" antes do dia · 3 dia desses
// dois · 4 depois de amanhã · 5 amanhã · 6 hoje · 7 dia da semana · 8/9/10
// dd/mm/aa · 11 "dia N" · 12 mês depois do dia · 13 "mês que vem" depois do dia.
// A alternativa "semana que vem + dia da semana" não captura nada: consome e cala.
const DATE_TOKEN_RE = new RegExp(
  `${B}(?:` +
    `(?:(${MONTHS})|(${NEXT_MONTH}))[\\s,]+(?:(?:s[óo]|n[oa]|l[áa]|pr[oa]|para\\s+o|pra)\\s+)*dia\\s+(\\d{1,2})(?![\\d/])` +
    `|(?:${NEXT_WEEK})[\\s,]+(?:(?:n[oa]|s[óo]|l[áa])\\s+)*(?:${WEEKDAYS})(?:[- ]feira)?` +
    '|(depois de amanh[ãa])' +
    '|(amanh[ãa])' +
    '|(hoje)' +
    `|(${WEEKDAYS})(?:[- ]feira)?(?![- ]feira)` +
    // Vírgula só antes de "semana que vem": "pago segunda, via pix" é segunda-feira.
    `(?!\\s*(?:parcela|via|vez|etapa)|[\\s,]*(?:(?:d[ao]\\s+|n[ao]\\s+)?(?:${NEXT_WEEK})|${QV}))` +
    '|(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2}|\\d{4}))?' +
    '|dia (\\d{1,2})(?![\\d/])' +
    `(?:\\s+(?:d[eo]\\s+|n[oa]\\s+)?(?:(${MONTHS})|(${NEXT_MONTH})))?` +
    `)${E}`,
  'giu',
)

/** Dia e mês sem ano: deste ano se ainda não passou; senão o ano que vem, só até 60 dias à frente. */
function dayMonthFrom(today: Date, month: number, day: number): Date | null {
  const y = today.getUTCFullYear()
  const d = validUtc(y, month, day)
  if (d && d >= today) return d
  // Virada de ano ("05/01" dito em dezembro); data velha ("paguei 11/09") fica de fora.
  const next = validUtc(y + 1, month, day)
  return next && next.getTime() - today.getTime() <= 60 * DAY_MS ? next : null
}

/** "Dia N" do mês seguinte ao de hoje (dezembro → janeiro do ano que vem). */
function dayOfNextMonth(today: Date, day: number): Date | null {
  const y = today.getUTCFullYear()
  const month = today.getUTCMonth() + 1
  return month === 12 ? validUtc(y + 1, 1, day) : validUtc(y, month + 1, day)
}

/**
 * Datas citadas pelo cliente, em ordem, sem repetir ("YYYY-MM-DD"):
 * hoje · amanhã · depois de amanhã · dia da semana com ou sem "-feira"
 * (próxima ocorrência; se é hoje, +7) · dd/mm[/aa] (de hoje em diante) ·
 * "dia N de <mês>" · "<mês> dia N" · "dia N do mês que vem" · "mês que vem
 * dia N" · "dia N" (mês que vem se N já passou). "Semana que vem" com dia da
 * semana e "sexta que vem" não são data.
 * Leitor de reserva e de conferência: a KB disse "esperar até sexta" e o
 * modelo devolveu acordo SEM data — sem isso não havia de onde tirar 18/09.
 */
export function parsePtDates(text: string, todayKey: string): string[] {
  return parsePtDateTokens(text, todayKey).dates
}

/**
 * parsePtDates + os "dia N" ditos SEM mês (`bareDays`), para a conferência
 * com o modelo: numa conversa em dois turnos (a IA pergunta "qual dia do mês
 * que vem?" e o cliente diz só "dia 20"), o leitor só vê "dia 20" e lê 20/09;
 * quem sabe que é outubro é o modelo, que leu a conversa.
 */
export function parsePtDateTokens(text: string, todayKey: string): { dates: string[]; bareDays: number[] } {
  const today = utcFromKey(todayKey)
  const dates: string[] = []
  const bareDays: number[] = []
  if (!today || !text) return { dates, bareDays }
  const push = (d: Date | null) => {
    if (!d) return
    const k = keyOf(d)
    if (!dates.includes(k)) dates.push(k)
  }
  const monthOf = (name: string) => MONTH_INDEX[stripAccents(name.toLowerCase())]

  for (const m of text.matchAll(DATE_TOKEN_RE)) {
    if (m[3]) {
      // "outubro, dia 20" / "mês que vem dia 20": o mês veio antes do dia.
      const n = Number(m[3])
      if (n < 1 || n > 31) continue
      if (m[1]) {
        const month = monthOf(m[1])
        if (month) push(dayMonthFrom(today, month, n))
      } else {
        push(dayOfNextMonth(today, n))
      }
    } else if (m[4]) push(addDays(today, 2))
    else if (m[5]) push(addDays(today, 1))
    else if (m[6]) push(today)
    else if (m[7]) {
      const wd = WEEKDAY_INDEX[stripAccents(m[7].toLowerCase())]
      if (wd === undefined) continue
      const diff = (wd - today.getUTCDay() + 7) % 7 || 7
      push(addDays(today, diff))
    } else if (m[8] && m[9]) {
      const day = Number(m[8])
      const month = Number(m[9])
      if (m[10]) {
        const y = m[10].length === 2 ? 2000 + Number(m[10]) : Number(m[10])
        const d = validUtc(y, month, day)
        if (d && d >= today) push(d)
        continue
      }
      push(dayMonthFrom(today, month, day))
    } else if (m[11]) {
      const n = Number(m[11])
      if (n < 1 || n > 31) continue
      if (m[12]) {
        // "dia 25 de outubro": o mês dito manda.
        const month = monthOf(m[12])
        if (month) push(dayMonthFrom(today, month, n))
      } else if (m[13]) {
        // "dia 20 do mês que vem" / "do próximo mês": sempre o mês seguinte.
        push(dayOfNextMonth(today, n))
      } else {
        if (!bareDays.includes(n)) bareDays.push(n)
        if (n >= today.getUTCDate()) push(validUtc(today.getUTCFullYear(), today.getUTCMonth() + 1, n))
        else push(dayOfNextMonth(today, n))
      }
    }
    // Sem grupo: "semana que vem na sexta" — consumido sem data (o modelo decide).
  }
  return { dates, bareDays }
}

/**
 * A data que vale: a do modelo quando o leitor a encontra no texto (ou quando
 * o texto não traz data que o leitor entenda, ou quando o cliente disse só
 * "dia N" e o modelo deu o mesmo dia N em outro mês); a do leitor quando o
 * modelo não deu nenhuma e só há UMA no texto ("não tenho hoje, pago sexta"
 * sem data do modelo é ambíguo → nenhuma). Os dois divergem → nenhuma. Passado
 * ou depois de hoje+45 dias → nenhuma.
 */
export function resolveDate(model: string | null, parsed: string[], todayKey: string, bareDays: number[] = []): string | null {
  const d = agreedDate(model, parsed, bareDays)
  if (!d) return null
  if (d < todayKey) return null
  if (isTooFar(d, todayKey)) return null
  return d
}

/** A data em que modelo e leitor concordam, sem olhar se já passou ou se é longe. */
function agreedDate(model: string | null, parsed: string[], bareDays: number[] = []): string | null {
  const m = model && /^\d{4}-\d{2}-\d{2}$/.test(model) ? model : null
  if (m && parsed.includes(m)) return m
  if (!parsed.length) return m
  if (!m) return parsed.length === 1 ? parsed[0] : null
  // "dia 20" sem mês e o modelo deu dia 20 de outro mês: o mês veio da
  // conversa ("qual dia do mês que vem?"), que o leitor não vê.
  if (bareDays.includes(Number(m.slice(8, 10)))) return m
  return null
}

const isTooFar = (d: string, todayKey: string) => d > addDaysKey(todayKey, MAX_PROMISE_DAYS)

// ---------------------------------------------------------------- valores

const AMOUNT_RE = /R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?/g

/** Valores em reais citados ("R$ 1.234,56", "R$ 170,93", "R$ 150"). */
export function amountsIn(text: string): number[] {
  const out: number[] = []
  for (const m of (text ?? '').matchAll(AMOUNT_RE)) {
    const reais = Number(m[1].replace(/\./g, ''))
    const cents = m[2] ? Number(m[2]) : 0
    if (Number.isFinite(reais)) out.push((reais * 100 + cents) / 100)
  }
  return out
}

/**
 * Algum valor bate com uma parcela aberta ou com uma soma delas (até 10)?
 * Por parcela, de valor − R$ 1 até o MAIOR entre valor + juros do Asaas e
 * valor + 10 %, + R$ 1.
 *
 * 16/09 (revisão): com juros informados valia só valor + juros (± R$ 1) — quem
 * pagou o valor original por boleto (R$ 165 contra 165 + 5,93) ganhava nota
 * "não bate com R$ 165,00", e juros que cresceram depois do último sync também
 * ficavam de fora.
 */
export function amountMatchesOpen(amounts: number[], charges: OpenCharge[]): boolean {
  const list = charges.slice(0, RECEIPT_MAX_CHARGES)
  const n = list.length
  if (!n || !amounts.length) return false
  const cents = (v: number) => Math.round(v * 100)
  const want = amounts.map(cents)
  const slack = cents(RECEIPT_TOLERANCE_ABS)
  for (let mask = 1; mask < 1 << n; mask++) {
    let lo = 0
    let hi = 0
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue
      const v = cents(list[i].value)
      const iv = list[i].interestValue
      const j = iv != null && iv > 0 ? cents(iv) : 0
      lo += v
      hi += Math.max(v + j, Math.round(v * (1 + RECEIPT_TOLERANCE_RATIO)))
    }
    if (want.some((a) => a >= lo - slack && a <= hi + slack)) return true
  }
  return false
}

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

// ---------------------------------------------------------------- decisão

export type ReplyDecision =
  | { action: 'apply'; kind: CollectionReplyKind; date: string | null; pause: boolean; moveDueDate: boolean; relevance: Relevance }
  | { action: 'note'; kind: CollectionReplyKind; text: string; relevance: Relevance }
  | { action: 'skip'; reason: string }

export interface ReplyDecisionInput {
  /** Palpite do modelo (silencioso) ou marcador da IA que conversa. */
  kind: CollectionReplyKind | 'nenhum'
  date: string | null
  /** O modelo disse que a fala é sobre a dívida? (ausente = não disse) */
  aboutDebt?: boolean | null
  relevance: Relevance | null
  typed: string
  media: string
  openCharges: OpenCharge[]
  otherPixLast24h: boolean
  /** Hoje no fuso da conta ("YYYY-MM-DD"). */
  todayKey: string
}

const CONTEST_RELEVANCE: ReadonlySet<Relevance> = new Set(['direct', 'recent_collection', 'asked_debt', 'mentions_debt'])

/**
 * O que fazer com a resposta: aplicar na régua, só deixar nota para o
 * responsável ou nada. O regex nunca transforma "nenhum" em efeito.
 */
export function decideCollectionReply(input: ReplyDecisionInput): ReplyDecision {
  const { relevance, typed } = input
  const skip = (reason: string): ReplyDecision => ({ action: 'skip', reason })
  if (!relevance) return skip('fora de contexto de cobrança')
  const modelKind = input.kind
  if (modelKind === 'nenhum') return skip('modelo: nenhum')
  if (input.aboutDebt === false) return skip('modelo: outro assunto')

  const direct = relevance === 'direct'
  // Quem responde a uma pergunta nossa sobre a dívida nunca fica pior do que
  // quem só recebeu um link (revisão 16/09).
  const nearCollection = direct || relevance === 'recent_collection' || relevance === 'asked_debt'
  // Responde a uma pergunta NOSSA sobre a dívida: a cobrança com link na
  // conversa, ou o Leonardo perguntando "Consegue fazer a parcela de hoje?"
  // sem link — aí "consigo sexta" basta, sem palavra de pagamento.
  const answersUs = direct || relevance === 'asked_debt'
  const { dates: parsed, bareDays } = parsePtDateTokens(typed, input.todayKey)
  const date = resolveDate(input.date, parsed, input.todayKey, bareDays)
  const agreed = agreedDate(input.date, parsed, bareDays)
  const tooFar = !!agreed && isTooFar(agreed, input.todayKey)
  const apply = (kind: CollectionReplyKind, extra: { date?: string | null; pause?: boolean; moveDueDate?: boolean } = {}): ReplyDecision => ({
    action: 'apply',
    kind,
    date: extra.date ?? null,
    pause: extra.pause ?? false,
    moveDueDate: extra.moveDueDate ?? false,
    relevance,
  })
  const note = (kind: CollectionReplyKind, text: string): ReplyDecision => ({ action: 'note', kind, text, relevance })

  let kind: CollectionReplyKind = modelKind

  // "Já paguei isso" marcado como contestação: é comprovante (régua dorme 3
  // dias e alguém confere), não pausa sem fim.
  if (kind === 'contesta' && !CONTEST_RE.test(typed)) {
    if (!PAID_CLAIM_RE.test(typed)) return skip('contesta sem contestação explícita')
    kind = 'comprovante'
  }

  if (kind === 'acordo') {
    if (!NEGOTIATION_RE.test(typed)) {
      // KB 14/09: "se puder esperar até sexta" é prazo com dia → promessa.
      // "Quanto é o mínimo ?" (recarga) e "me passa o link pra eu acertar" → nada.
      if (!date) return skip('acordo sem pedido explícito de negociação')
      kind = 'promessa'
    } else if (!direct) {
      return note('acordo', '🧾 Parece pedido de acordo ou parcelamento, mas não em resposta a uma cobrança desta conversa — a régua NÃO parou. Se for o caso, pause na lateral da conversa.')
    } else {
      return apply('acordo', { pause: true })
    }
  }

  if (kind === 'contesta') {
    if (CONTEST_RELEVANCE.has(relevance)) return apply('contesta', { pause: true })
    return note('contesta', '🧾 Parece que o cliente contesta a cobrança, mas a mensagem não responde a uma cobrança recente — a régua NÃO parou. Se for o caso, pause na lateral da conversa.')
  }

  if (kind === 'promessa') {
    // Fora da conversa da cobrança, promessa exige falar em pagar ou na dívida:
    // "Fazemos amanhã então" (recarga) não segura a régua nem com cobrança ontem.
    if (!answersUs && !PAY_WORD_RE.test(typed) && !PAID_CLAIM_RE.test(typed) && !DEBT_WORD_RE.test(typed)) {
      return skip('promessa sem falar em pagar fora da conversa da cobrança')
    }
    if (!date) {
      // Data depois de hoje+45: não segura a régua; só a conversa da cobrança ganha nota.
      if (tooFar && agreed) {
        if (!direct) return skip('promessa para mais de 45 dias')
        return note('promessa', `🧾 O cliente falou em pagar só em ${brDate(agreed)}, mais de ${MAX_PROMISE_DAYS} dias à frente. A régua continua no ritmo normal — se isso foi combinado, use "Registrar promessa".`)
      }
      if (!nearCollection) return skip('promessa sem data')
      return note('promessa', '🧾 O cliente falou em pagar, mas sem data que desse para calcular. A régua continua no ritmo normal — se ele combinou um dia, use "Registrar promessa".')
    }
    // Vencimento no Asaas só se move com resposta DIRETA à cobrança.
    return apply('promessa', { date, moveDueDate: direct })
  }

  // comprovante
  const amounts = amountsIn(input.media)
  if (amounts.length && !amountMatchesOpen(amounts, input.openCharges)) {
    // Ótica Exemplo 16/09: Pix de R$ 150 ao Google logo depois de mandarmos o Pix do Google.
    if (input.otherPixLast24h || !nearCollection) return skip('valor do comprovante não bate com o que está aberto')
    const open = input.openCharges.slice(0, 4).map((c) => brl(c.value)).join(', ')
    return note(
      'comprovante',
      `🧾 Chegou um comprovante de ${amounts.map(brl).join(', ')}, que não bate com o que está em aberto (${open}). A régua não mudou — confira se é desta cobrança.`,
    )
  }
  if (!input.media.trim() && !answersUs && !PAID_CLAIM_RE.test(typed) && !PAY_WORD_RE.test(typed)) {
    return skip('comprovante sem imagem nem fala de pagamento fora da conversa da cobrança')
  }
  return apply('comprovante')
}

// ---------------------------------------------------------------- duplicata

export interface TouchState {
  snoozeUntil: string | null
  snoozeReason: string | null
  paused: boolean
  pausedSource: string | null
  pausedReason: string | null
  updatedAt: string | null
  /**
   * Quando o último comprovante foi aplicado (KV de 12 h, reply-context.ts).
   * O motivo gravado não basta: o GREATEST do comprovante mantém a promessa
   * mais longa e o motivo dela.
   */
  receiptAt?: string | null
  /** Até quando a régua ficou parada DEPOIS daquele comprovante (mesmo KV). */
  receiptUntil?: string | null
}

/**
 * O mesmo efeito já está na régua? (a rajada é classificada de novo a cada
 * balão: Loja 77 16/09 09:16:41 e :50, Lúcia 12:21 e 12:29, Modelix 13:53 e
 * 14:00). As execuções da mesma conversa andam em fila pelo lock da
 * auto-resposta, então olhar o estado gravado basta — sem migração.
 */
export function alreadyApplied(touch: TouchState | null | undefined, kind: CollectionReplyKind, date: string | null, now = new Date()): boolean {
  if (!touch) return false
  const until = toMs(touch.snoozeUntil)
  const sleeping = Number.isFinite(until) && until > now.getTime()
  switch (kind) {
    case 'promessa': {
      if (!date || !sleeping) return false
      // 16/09 (revisão): a mesma promessa aparece gravada de três jeitos. Com
      // "mover vencimento" ligado, changeChargeDueDateCore regrava o motivo como
      // "Vencimento alterado para 18/09/2026" — e o "sem falta" 9 s depois
      // tentava mover de novo e deixava nota de erro ("O vencimento já é…").
      // Promessa registrada pela tela ("… — registrado por João: obs") também
      // vale: a IA não sobrescreve o motivo que a pessoa escreveu.
      const reason = touch.snoozeReason ?? ''
      return reason === promiseSnoozeReason(date) || reason === dueDateMovedReason(date) || reason.startsWith(manualPromiseReasonPrefix(date))
    }
    case 'comprovante': {
      // Loja 77 (revisão): promessa até 20/09 + comprovante lido 2x em 9 s → o
      // motivo continuava o da promessa e a 2ª leitura repetia nota e aviso a
      // todos. O registro do comprovante aplicado vale mesmo sem o motivo.
      //
      // Revisão 2 (16/09): só enquanto aquele adiamento AINDA vale. Comprovante
      // errado às 09:00 (B.C Fretes: Pix para outra pessoa), João confere,
      // não acha e clica "Cobrar agora" (zera o adiamento, o KV fica); às 14:00
      // chega o comprovante verdadeiro e era descartado sem nota nem aviso — a
      // régua voltava a cobrar quem tinha acabado de pagar. Adiamento novo mais
      // curto que o do comprovante (promessa gravada depois do "Cobrar agora")
      // também não é dele.
      const receipt = toMs(touch.receiptAt)
      if (sleeping && Number.isFinite(receipt) && now.getTime() - receipt < RECEIPT_DEDUP_MS) {
        const heldUntil = toMs(touch.receiptUntil)
        if (!Number.isFinite(heldUntil) || until >= heldUntil - 60_000) return true
      }
      const updated = toMs(touch.updatedAt)
      return sleeping && touch.snoozeReason === RECEIPT_SNOOZE_REASON && Number.isFinite(updated) && now.getTime() - updated < RECEIPT_DEDUP_MS
    }
    case 'acordo':
      return touch.paused && isAiPause(touch) && touch.pausedReason === ACORDO_PAUSE_REASON
    case 'contesta':
      return touch.paused && isAiPause(touch) && touch.pausedReason === CONTESTA_PAUSE_REASON
    default:
      return false
  }
}

/**
 * Assinatura curta de uma nota sem efeito (tipo + texto), para a trava de nota
 * repetida. 16/09 (revisão): nota não mexe na régua, então alreadyApplied não
 * a enxerga — "vou pagar" e, 2 min depois, "assim que cair o dinheiro" davam
 * duas notas iguais e dois avisos ao responsável. O texto é nosso (modelo de
 * frase + valores), nunca a fala do cliente.
 */
export function noteSignature(kind: CollectionReplyKind, text: string): string {
  let h = 5381
  const s = `${kind}\n${text}`
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return `${kind}:${h.toString(16)}`
}

// ---------------------------------------------------------------- fuso e entrada do classificador

function partsIn(date: Date, timezone: string): Record<string, string> | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
    return Object.fromEntries(parts.map((p) => [p.type, p.value]))
  } catch {
    return null
  }
}

/** Hoje ("YYYY-MM-DD") no fuso da conta; fuso inválido → horário de Brasília. */
export function dayKeyIn(timezone: string, now = new Date()): string {
  const p = partsIn(now, timezone) ?? partsIn(now, 'America/Sao_Paulo')
  if (!p) return new Date(now.getTime() - 3 * HOUR_MS).toISOString().slice(0, 10)
  return `${p.year}-${p.month}-${p.day}`
}

/** "14/09 14:35" no fuso da conta. */
export function stampIn(date: Date, timezone: string): string {
  const p = partsIn(date, timezone) ?? partsIn(date, 'America/Sao_Paulo')
  if (!p) return date.toISOString().slice(5, 16)
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`
}

/** Texto de terceiro dentro de uma marca <…>: sem marcador e sem fechar a marca. */
const inTag = (s: string, maxChars: number) => neutralizeUntrusted(s, { maxChars }).replace(/</g, '‹')

/**
 * Entrada do classificador silencioso: a dívida, quando saiu a última
 * cobrança, as últimas mensagens da empresa e a rajada do cliente. Antes o
 * modelo via só `<cliente>Fazemos amanhã então</cliente>` e não tinha como saber
 * que o assunto era a recarga do Google Ads.
 */
export function buildClassifierInput(args: {
  debt: string | null
  lastCollection: { at: Date; sameConversation: boolean } | null
  /** Da mais nova para a mais velha (entram as 4 mais novas). */
  ours: OurMessage[]
  /** Do mais velho para o mais novo. */
  bubbles: BurstRow[]
  timezone: string
}): string {
  const lines: string[] = []
  lines.push('<divida>', args.debt?.trim() || 'sem detalhe', '</divida>')
  lines.push(
    args.lastCollection
      ? `Última cobrança enviada: ${stampIn(args.lastCollection.at, args.timezone)} ${args.lastCollection.sameConversation ? 'nesta conversa' : 'em outro canal'}`
      : 'Última cobrança enviada: nenhuma nos últimos 7 dias',
  )

  const ours = args.ours.slice(0, 4).reverse()
  lines.push('<empresa>')
  if (!ours.length) lines.push('(nenhuma mensagem recente)')
  for (const m of ours) {
    const t = (m.text ?? '').replace(/\s+/g, ' ').trim()
    lines.push(`[${stampIn(m.at, args.timezone)}] ${t ? inTag(t, 300) : '(mídia)'}`)
  }
  lines.push('</empresa>')

  lines.push('<cliente>')
  let budget = 1500
  for (const b of args.bubbles) {
    if (budget <= 0) break
    // Mesma separação do pickBurst: a descrição da mídia vem marcada como
    // imagem/documento; a legenda, como fala do cliente.
    const { typed, media } = bubbleParts(b)
    const parts: string[] = []
    if (media) parts.push(`[${mediaLabel(b.contentType)}: ${inTag(media, budget)}]`)
    if (typed) parts.push(inTag(typed, budget))
    const body = parts.join(' ')
    if (!body) continue
    budget -= body.length
    const at = toMs(b.createdAt)
    lines.push(Number.isFinite(at) ? `[${stampIn(new Date(at), args.timezone)}] ${body}` : body)
  }
  lines.push('</cliente>')
  return lines.join('\n')
}
