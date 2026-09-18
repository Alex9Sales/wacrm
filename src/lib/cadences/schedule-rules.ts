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
