// ============================================================
// Regras puras do envio de degrau de cadência (sem banco — testáveis).
//
//   • horário de silêncio: cadência AUTOMÁTICA (lead do RD às 20h + "6 horas
//     depois") não pode sair de madrugada — empurra pro próximo 9h;
//   • texto × modelo: no canal que exige modelo (Meta), fora da janela de 24 h
//     só modelo aprovado chega. Com a janela aberta (o lead falou há pouco), o
//     texto do degrau é melhor — é conversa, não reengajamento.
// Sem 'server-only' — roda no worker.
// ============================================================

/** Janela de atendimento da Meta: 24 h desde a última mensagem do cliente. */
export const CUSTOMER_WINDOW_MS = 24 * 60 * 60 * 1000

/** Partes da hora LOCAL de `ms` no fuso `tz`. */
function localParts(ms: number, tz: string): { y: number; m: number; d: number; h: number; min: number; s: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second }
}

/** Epoch ms do horário LOCAL (y-m-d h:00) no fuso `tz`. */
function localToUtcMs(y: number, m: number, d: number, h: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, 0, 0)
  // Deslocamento do fuso nesse instante (em ms): local-como-UTC − real.
  const p = localParts(guess, tz)
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s)
  return guess - (asUtc - guess)
}

/**
 * Empurra `ms` pra fora do silêncio [`quietStart`h, `quietEnd`h) do fuso `tz`:
 * de noite vai pro dia seguinte às `resumeAt`h; de madrugada, pro mesmo dia às
 * `resumeAt`h. Fora do silêncio, devolve igual.
 */
export function shiftOutOfQuietHours(
  ms: number,
  tz: string,
  opts: { quietStart?: number; quietEnd?: number; resumeAt?: number } = {},
): number {
  const quietStart = opts.quietStart ?? 21
  const quietEnd = opts.quietEnd ?? 8
  const resumeAt = opts.resumeAt ?? 9
  let p: ReturnType<typeof localParts>
  try {
    p = localParts(ms, tz)
  } catch {
    return ms // fuso inválido: não mexe
  }
  if (p.h >= quietStart) {
    // Dia seguinte: soma um dia na data local (Date.UTC normaliza o fim de mês).
    const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1))
    return localToUtcMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), resumeAt, tz)
  }
  if (p.h < quietEnd) return localToUtcMs(p.y, p.m, p.d, resumeAt, tz)
  return ms
}

/**
 * A cadência que ANDA O CARD ainda vale pra ele? Motivo pra parar, ou null.
 *   • card fechado (ganho/perdido) ou apagado;
 *   • card em outro funil (alguém arrastou no RD);
 *   • card ALÉM da etapa mais avançada que a cadência move (o time adiantou:
 *     ex.: lead parado em "Novo lead" que o vendedor levou pra "Reunião
 *     agendada" pelo telefone — a nutrição tem que parar);
 *   • cadência PRESA A UMA ETAPA (todo toque que move leva pra MESMA etapa X)
 *     e o card VOLTOU pra trás de X no funil dela. Essa cadência é "enquanto o
 *     card está em X" (ex.: a sequência da COF, que entra quando o card chega
 *     em "Envio da COF"). Sem esta regra, o time devolvia o card pra "Reunião
 *     agendada" e o PRÓXIMO toque o puxava de novo pra X — redisparando o
 *     gatilho da etapa (01/10). Cadência que leva a etapas DIFERENTES (o
 *     pré-vendas: 2ª, 3ª, 4ª tentativa…) segue como antes: ali o card atrás
 *     da etapa do toque é o caminho normal.
 * `cadenceStages` = etapas pra onde os toques movem o card (uma por toque).
 * `movingStepsSent` (opcional) = quantos toques que movem o card JÁ saíram
 *   nesta inscrição. Com 0, o card ainda não foi levado a X pela cadência —
 *   estar atrás é "ainda não chegou", não "voltou" — e a regra da etapa presa
 *   não vale. checkCadenceStepStillWanted (cadence.ts) conta e manda.
 *   Só vale com 2+ toques na mesma etapa (um toque só que move não é "presa").
 */
export function cadenceStopReason(input: {
  deal: { status: string; pipelineId: string; stagePosition: number } | null
  cadenceStages: { pipelineId: string; position: number }[]
  movingStepsSent?: number
}): string | null {
  const { deal, cadenceStages } = input
  if (!cadenceStages.length) return null // cadência que não anda o card: nada muda
  if (!deal) return 'card apagado'
  if (deal.status !== 'open') return `card ${deal.status === 'won' ? 'ganho' : 'perdido'}`
  const inFunnel = cadenceStages.filter((s) => s.pipelineId === deal.pipelineId)
  if (!inFunnel.length) return 'card mudou de funil'
  const furthest = Math.max(...inFunnel.map((s) => s.position))
  if (deal.stagePosition > furthest) return 'card avançou além da cadência'
  // Etapa presa: todos os toques apontam pra mesma (funil, posição). Já se sabe
  // que o card está nesse funil (o filtro acima não ficou vazio).
  // Pelo menos 2 toques: cadência em que só o 1º toque move o card (ex.: pra
  // "Em contato") e os outros não movem não é "presa a uma etapa" — devolver o
  // card depois dela não pode cancelar os toques seguintes (revisão de 01/10).
  const stuck =
    cadenceStages.length >= 2 &&
    new Set(cadenceStages.map((s) => `${s.pipelineId}|${s.position}`)).size === 1
  if (stuck && input.movingStepsSent !== 0 && deal.stagePosition < cadenceStages[0].position) {
    return 'card voltou de etapa'
  }
  return null
}

/**
 * Como o degrau sai: 'template' quando o canal exige modelo (Meta), a janela
 * de 24 h está FECHADA e o degrau tem modelo; senão 'text' (inclusive Meta sem
 * modelo — comportamento de sempre: a Meta recusa e o degrau fica "falhou").
 */
export function cadenceSendMode(input: {
  channelTakesTemplates: boolean
  templateName: string | null | undefined
  lastInboundAt: string | Date | null | undefined
  now?: number
}): 'template' | 'text' {
  if (!input.channelTakesTemplates || !input.templateName?.trim()) return 'text'
  const now = input.now ?? Date.now()
  const last = input.lastInboundAt ? new Date(input.lastInboundAt).getTime() : NaN
  const windowOpen = Number.isFinite(last) && now - last < CUSTOMER_WINDOW_MS
  return windowOpen ? 'text' : 'template'
}

/** Piso de agendamento: o agendador exige horário futuro (o D0 sai em ~1 min). */
export const MIN_STEP_DELAY_MS = 60_000

/**
 * RETOMAR DE ONDE PAROU: quando sai um toque restante. O ritmo volta ao normal
 * contado da retomada — o toque espera o intervalo que ele tem em relação ao
 * último toque ENVIADO (`lastSentDelayMs`; 0 se nenhum saiu). Ex.: D0, +2d,
 * +4d; pausou depois do D0 → retomou → +2d e +4d a partir de agora.
 * 19/09 (Rafael): a 1ª versão contava do PRÓXIMO toque, que saía 1 min depois
 * de retomar, no meio da conversa com o lead.
 */
export function resumeSendAtMs(stepDelayMs: number, lastSentDelayMs: number, nowMs: number): number {
  return nowMs + Math.max(stepDelayMs - lastSentDelayMs, MIN_STEP_DELAY_MS)
}
