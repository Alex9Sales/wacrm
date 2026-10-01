// ============================================================
// 🙋 Transferência para humano ([[HANDOFF]]): desligar a IA de vez ou pausar
// por N minutos. Sem 'server-only' — o worker também usa. Tudo aqui é PURO
// (sem banco): a tela da conversa (componente cliente) importa daqui também.
//
// 29/09 (reunião, caso Zelo): o [[HANDOFF]] gravava ai_autoreply_disabled e a
// IA nunca mais voltava na conversa. A IA transferiu, o dono marcou a reunião
// à mão pelo WhatsApp e o card nunca andou — sem a IA, ninguém emitia os
// marcadores do funil. Agora a IA fica quieta N minutos (ai_paused_until) e
// volta sozinha se a pessoa escrever e ninguém tiver respondido. Os casos em
// que voltar não faz sentido continuam desligando de vez (handoffOutcome).
// ============================================================

/** Começo EXATO da nota interna gravada quando a IA pede um humano. Consultas
 *  (follow-up, contador de transferências) procuram por este prefixo — não
 *  mudar o texto sem varrer quem procura. */
export const HANDOFF_NOTE_PREFIX = '🙋 *A IA pediu um humano*'

/** Teto da pausa (min). 24h: mais que isso já é "desligar" com outro nome, e o
 *  contador de transferências (janela de 24h) deixaria de enxergar a anterior. */
export const HANDOFF_PAUSE_MAX_MINUTES = 1440

export type HandoffDisableReason = 'off' | 'lose' | 'cross_funnel' | 'repeat'

export type HandoffOutcome =
  | { kind: 'disable'; reason: HandoffDisableReason }
  | { kind: 'pause'; minutes: number }

/**
 * Decide o que a transferência faz com a IA NESTA conversa.
 *
 * Desliga de vez (como era antes de 29/09) quando:
 *  - `off`: o agente não tem pausa configurada (0 = comportamento antigo — é o
 *    padrão, ninguém muda de comportamento sem escolher);
 *  - `lose`: houve [[PERDER]] / o card foi perdido — não há o que retomar;
 *  - `cross_funnel`: o card foi para OUTRO funil sem ganho — lead de serviço ou
 *    de emprego que o SDR manda pro funil 3/4; quem cuida é outra equipe e a IA
 *    de vendas voltando ali só atrapalha. (Troca de funil COM ganho é o lead
 *    qualificado indo pra venda: aí a IA pode voltar.)
 *  - `repeat`: já houve transferência nesta conversa nas últimas 24h. A 2ª vez
 *    desliga: evita o laço "pausa → volta → pede humano de novo → pausa", com
 *    um aviso novo ao dono a cada volta.
 * Senão, pausa pelos minutos configurados (limitados a 24h).
 */
export function handoffOutcome(input: {
  pauseMinutes: number | null | undefined
  lose: boolean
  crossFunnel: boolean
  win: boolean
  priorHandoffs24h: number
}): HandoffOutcome {
  const raw = Number(input.pauseMinutes)
  if (!Number.isFinite(raw) || raw <= 0) return { kind: 'disable', reason: 'off' }
  if (input.lose) return { kind: 'disable', reason: 'lose' }
  if (input.crossFunnel && !input.win) return { kind: 'disable', reason: 'cross_funnel' }
  if (input.priorHandoffs24h > 0) return { kind: 'disable', reason: 'repeat' }
  // Fração de minuto (valor vindo de fora da tela) vira pelo menos 1 min.
  const minutes = Math.min(HANDOFF_PAUSE_MAX_MINUTES, Math.max(1, Math.floor(raw)))
  return { kind: 'pause', minutes }
}

/** Por que a IA foi desligada — vai na nota e no aviso ao dono, pra ninguém ter
 *  de adivinhar por que a pausa configurada não valeu desta vez. */
const DISABLE_WHY: Record<Exclude<HandoffDisableReason, 'off'>, string> = {
  lose: 'o lead foi marcado como perdido',
  cross_funnel: 'o lead foi para outro funil',
  repeat: 'é a 2ª transferência em 24h',
}

/**
 * Complemento da PRIMEIRA linha da nota interna (logo depois do
 * HANDOFF_NOTE_PREFIX, que fica idêntico). `off` = sem complemento: a nota
 * sai exatamente como antes da pausa existir.
 */
export function handoffNoteSuffix(outcome: HandoffOutcome): string {
  if (outcome.kind === 'pause') {
    return ` — IA pausada por ${outcome.minutes} min (volta sozinha se a pessoa escrever e ninguém responder)`
  }
  if (outcome.reason === 'off') return ''
  return ` — IA desligada nesta conversa (${DISABLE_WHY[outcome.reason]}); religue quando quiser que ela volte`
}

/** {{motivo}} do aviso de transferência ao dono no WhatsApp. */
export function handoffAlertMotivo(outcome: HandoffOutcome): string {
  const base = 'A IA pediu um humano nesta conversa'
  if (outcome.kind === 'pause') {
    return `${base} — ela fica pausada por ${outcome.minutes} min e volta sozinha se a pessoa escrever e ninguém responder`
  }
  if (outcome.reason === 'off') return base
  return `${base} — a IA foi desligada nesta conversa (${DISABLE_WHY[outcome.reason]})`
}

/** A pausa ainda vale? Aceita o valor cru do banco (string ISO), Date ou nulo.
 *  Data ilegível = não pausada (melhor a IA responder que calar sem motivo). */
export function aiPauseActive(
  until: string | Date | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!until) return false
  const t = new Date(until).getTime()
  return Number.isFinite(t) && t > now
}

/** "HH:MM" no fuso da conta — rótulo da tela ("IA pausada até 14:30") e do
 *  contexto pós-pausa. Fuso inválido cai em America/Sao_Paulo. */
export function formatPauseClock(at: string | Date, timezone?: string | null): string {
  const d = new Date(at)
  const fmt = (tz: string) =>
    d.toLocaleTimeString('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
  try {
    return fmt(timezone || 'America/Sao_Paulo')
  } catch {
    return fmt('America/Sao_Paulo')
  }
}

/** "DD/MM" no fuso da conta (só pra dizer QUAL dia, quando não é hoje). */
function formatDayMonth(at: Date, timezone: string): string {
  const f = (tz: string) => at.toLocaleDateString('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit' })
  try {
    return f(timezone)
  } catch {
    return f('America/Sao_Paulo')
  }
}

/**
 * Instrução de sistema para a IA que VOLTA depois de ter pedido um humano
 * (nota HANDOFF_NOTE_PREFIX nas últimas 24h). Sem isto ela voltava "do zero":
 * cumprimentava de novo e recomeçava a qualificação com quem já tinha sido
 * passado para a equipe. Em inglês, como as regras vizinhas do prompt.
 */
export function handoffContextInstruction(input: {
  handoffAt: string | Date
  timezone?: string | null
  now?: Date
}): string {
  const tz = input.timezone || 'America/Sao_Paulo'
  const at = new Date(input.handoffAt)
  const now = input.now ?? new Date()
  const clock = formatPauseClock(at, tz)
  const sameDay = formatDayMonth(at, tz) === formatDayMonth(now, tz)
  const when = sameDay ? `today at ${clock}` : `on ${formatDayMonth(at, tz)} at ${clock}`
  return (
    `HANDED OFF TO A HUMAN: ${when} (account time) you passed this conversation to a human teammate, who was notified. ` +
    'Do NOT restart the qualification and do not greet the customer as if this were a new conversation — what they already told us still stands. ' +
    'If they write now, briefly acknowledge that the team has been notified and will get back to them, and help with whatever you safely can in the meantime. ' +
    'If a teammate has already replied after that, follow their lead. ' +
    'Only emit [[HANDOFF]] again if the customer insists on talking to a person right now.'
  )
}
