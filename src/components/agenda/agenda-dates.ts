// ============================================================
// Agenda — contas de data puras (sem React), para dar para testar.
// Tudo em horário LOCAL do navegador (getDate/setDate), como o resto da
// Agenda: o Brasil não tem horário de verão, mas o navegador pode estar em
// outro fuso — por isso nada aqui soma 86.400.000 ms para "andar um dia".
// ============================================================

export const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

export const pad = (n: number) => String(n).padStart(2, '0')
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
export const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** Meia-noite local de `n` dias depois (n negativo volta). */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "2026-10-03" (input date) → meia-noite local; null se vazio/inválido. */
export function parseDateInput(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}
/** "2026-10-03T11:00" (input datetime-local) → horário local; null se vazio/inválido. */
export function parseLocalInput(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
}

/** 42 dias (6 semanas) começando no domingo da semana do dia 1º. */
export function monthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const start = addDays(first, -first.getDay()) // volta até o domingo
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

/**
 * Semana de domingo a sábado — a MESMA convenção da grade do mês. Como a
 * grade do mês do dia focado sempre contém a semana inteira dele, a Semana
 * reaproveita o carregamento do Mês sem buscar nada a mais.
 */
export function startOfWeek(d: Date): Date {
  return addDays(d, -d.getDay())
}
export function weekDays(d: Date): Date[] {
  const start = startOfWeek(d)
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

/** "27 set – 3 out 2026" (o ano só se repete quando a semana vira o ano). */
export function weekRangeLabel(d: Date): string {
  const days = weekDays(d)
  const a = days[0]
  const b = days[6]
  const fim = `${b.getDate()} ${MESES_CURTOS[b.getMonth()]} ${b.getFullYear()}`
  if (a.getFullYear() !== b.getFullYear()) {
    return `${a.getDate()} ${MESES_CURTOS[a.getMonth()]} ${a.getFullYear()} – ${fim}`
  }
  if (a.getMonth() !== b.getMonth()) return `${a.getDate()} ${MESES_CURTOS[a.getMonth()]} – ${fim}`
  return `${a.getDate()} – ${fim}`
}

const UMA_HORA_MS = 3_600_000

function diasEntre(a: Date, b: Date): number {
  // Pelo calendário, não por ms: dia de troca de horário tem 23 ou 25 horas.
  return Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
      Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) /
      86_400_000,
  )
}

/**
 * Novo FIM quando o INÍCIO muda: o compromisso anda inteiro, com a duração
 * que já tinha (1h se não havia uma válida; no dia inteiro, o mesmo nº de
 * dias). 01/10: na clínica, passaram o início para 03/10 11:00 e o fim ficou
 * em 01/10 12:00 — antes do começo — e só deu para corrigir à mão.
 * Início novo ainda incompleto (o campo devolve "" enquanto digita): o fim
 * fica como está.
 */
export function shiftEndWithStart(
  prevStart: string,
  prevEnd: string,
  nextStart: string,
  allDay: boolean,
): string {
  if (allDay) {
    const s1 = parseDateInput(nextStart)
    if (!s1) return prevEnd
    const s0 = parseDateInput(prevStart)
    const e0 = parseDateInput(prevEnd)
    const dias = s0 && e0 && e0 >= s0 ? diasEntre(s0, e0) : 0
    return toDateInput(addDays(s1, dias))
  }
  const s1 = parseLocalInput(nextStart)
  if (!s1) return prevEnd
  const s0 = parseLocalInput(prevStart)
  const e0 = parseLocalInput(prevEnd)
  const dur = s0 && e0 && e0 > s0 ? e0.getTime() - s0.getTime() : UMA_HORA_MS
  return toLocalInput(new Date(s1.getTime() + dur))
}

const fmtDia = (d: Date) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
const fmtDiaHora = (d: Date) => `${fmtDia(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`

/** O que está errado no par início/fim do formulário, ou null se dá para salvar. */
export function scheduleError(start: string, end: string, allDay: boolean): string | null {
  const parse = allDay ? parseDateInput : parseLocalInput
  const fmt = allDay ? fmtDia : fmtDiaHora
  const s = parse(start)
  const e = parse(end)
  if (!s) return 'Preencha o início.'
  if (!e) return 'Preencha o fim.'
  if (e < s) return `O fim (${fmt(e)}) está antes do início (${fmt(s)}). Ajuste o fim.`
  return null
}

export type DaySlot<T> = {
  event: T
  /** Minutos desde a meia-noite do dia (relógio de parede), já cortados ao dia. */
  startMin: number
  endMin: number
  /** Coluna do evento dentro do grupo que se sobrepõe, e quantas colunas o grupo tem. */
  col: number
  cols: number
}

/**
 * Posiciona os eventos com horário de UM dia na grade de horas. Antes, na
 * visão Dia, dois compromissos no mesmo horário ficavam um em cima do outro
 * e só o último aparecia — com as agendas dos profissionais juntas ("Todas")
 * isso é o normal, não a exceção. Quem se sobrepõe divide a largura.
 * Evento que atravessa a meia-noite aparece cortado em cada dia.
 * `minMinutes` é a altura mínima na tela: conta também para a sobreposição,
 * senão um evento curto ficaria escondido atrás do vizinho.
 */
export function layoutDayEvents<T extends { startsAt: string; endsAt: string }>(
  events: T[],
  day: Date,
  minMinutes = 30,
): DaySlot<T>[] {
  const ini = startOfDay(day)
  const fimDoDia = addDays(ini, 1)
  const minutos = (d: Date) => (d >= fimDoDia ? 1440 : d <= ini ? 0 : d.getHours() * 60 + d.getMinutes())

  const itens: { event: T; startMin: number; endMin: number; visEnd: number }[] = []
  for (const event of events) {
    const s = new Date(event.startsAt)
    const e = new Date(event.endsAt)
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) continue
    if (e < ini || s >= fimDoDia) continue
    // Termina exatamente à meia-noite deste dia: é do dia anterior.
    if (e.getTime() === ini.getTime() && e > s) continue
    const startMin = minutos(s)
    const endMin = Math.max(startMin, minutos(e))
    itens.push({ event, startMin, endMin, visEnd: Math.min(1440, Math.max(endMin, startMin + minMinutes)) })
  }
  itens.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin)

  const out: DaySlot<T>[] = []
  let grupo: DaySlot<T>[] = []
  let fimColunas: number[] = []
  let fimGrupo = -1
  const fecharGrupo = () => {
    for (const g of grupo) g.cols = fimColunas.length
    grupo = []
    fimColunas = []
  }
  for (const it of itens) {
    if (it.startMin >= fimGrupo) fecharGrupo()
    let col = fimColunas.findIndex((f) => f <= it.startMin)
    if (col === -1) {
      col = fimColunas.length
      fimColunas.push(it.visEnd)
    } else {
      fimColunas[col] = it.visEnd
    }
    fimGrupo = Math.max(fimGrupo, it.visEnd)
    const slot: DaySlot<T> = { event: it.event, startMin: it.startMin, endMin: it.endMin, col, cols: 1 }
    grupo.push(slot)
    out.push(slot)
  }
  fecharGrupo()
  return out
}
