// ============================================================
// ⏰ Horário já ocupado nesta agenda? — a parte pura (02/10/2026).
//
// 02/10, numa clínica com uma agenda do Google por profissional: a mesma
// consulta foi lançada DUAS vezes — uma digitada direto no Google, sem paciente
// ligado, e outra pelo CRM, no mesmo horário da mesma agenda. A pergunta
// "remarcação ou consulta nova?" (remarcacao.ts) só olha as consultas do
// PACIENTE ligado, e a do Google não tinha paciente: passou calada.
//
// Agora o modal pergunta ao servidor se já há, na MESMA agenda, compromisso de
// pé ('confirmed') que ocupa o horário (busy — "Mostrar como: Disponível" no
// Google não ocupa) e se cruza com o horário do formulário. Achou: diz no
// lugar — "Já há 'X' das 14:00 às 15:00 nesta agenda." — e o salvar pede um
// clique em "Salvar mesmo assim". Não bloqueia de vez: encaixe existe, e quem
// decide é a recepção. Paciente ligado ou não, tanto faz (o caso real não
// tinha).
//
// Sem banco e sem 'server-only': a action (compromissosNoHorario) e o modal
// usam as mesmas regras.
// ============================================================

import { FUSO_PADRAO } from './confirmacao-agendamento'

/** Um compromisso como a busca lê do banco. */
export type CompromissoNoHorario = {
  id: string
  calendarId: string
  title: string
  startsAt: string
  endsAt: string
  allDay: boolean
  status: string
  busy: boolean
}

/** O que a tela recebe de cada compromisso que já ocupa o horário. */
export type HorarioOcupado = Pick<CompromissoNoHorario, 'id' | 'title' | 'startsAt' | 'endsAt' | 'allDay'>

/** O horário do formulário. `ignorarId` = o próprio compromisso, na edição. */
export type PedidoDeHorario = {
  calendarId: string
  startsAt: string
  endsAt: string
  ignorarId?: string | null
}

const UMA_HORA = 3_600_000

/**
 * O intervalo como o salvar vai GRAVAR: fim antes (ou igual) do início vira
 * início + 1h, igual a createEvent/updateEvent. null = data ilegível.
 */
export function intervaloDoPedido(p: { startsAt: string; endsAt: string }): { inicio: number; fim: number } | null {
  const inicio = new Date(p.startsAt).getTime()
  let fim = new Date(p.endsAt).getTime()
  if (!Number.isFinite(inicio)) return null
  if (!Number.isFinite(fim) || fim <= inicio) fim = inicio + UMA_HORA
  return { inicio, fim }
}

/**
 * Os dois cruzam? Encostar não é cruzar: a consulta das 14h às 15h e a das
 * 15h às 16h estão uma depois da outra, não uma em cima da outra.
 */
export function sobrepoe(a: { inicio: number; fim: number }, b: { startsAt: string; endsAt: string }): boolean {
  const bi = new Date(b.startsAt).getTime()
  const bf = new Date(b.endsAt).getTime()
  if (!Number.isFinite(bi) || !Number.isFinite(bf)) return false
  return a.inicio < bf && bi < a.fim
}

/**
 * Quem já ocupa o horário do pedido: mesma agenda, de pé, ocupando (busy),
 * cruzando o intervalo e que não é o próprio compromisso. Do mais cedo para o
 * mais tarde. A action filtra no SQL e passa por aqui de novo — a regra mora
 * num lugar só.
 */
export function conflitosNoHorario<C extends CompromissoNoHorario>(pedido: PedidoDeHorario, linhas: C[]): C[] {
  const intervalo = intervaloDoPedido(pedido)
  if (!intervalo || !pedido.calendarId) return []
  return linhas
    .filter(
      (c) =>
        c.calendarId === pedido.calendarId &&
        c.status === 'confirmed' &&
        c.busy === true &&
        (!pedido.ignorarId || c.id !== pedido.ignorarId) &&
        sobrepoe(intervalo, c),
    )
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
}

function partesNoFuso(iso: string, tz: string): { hora: string; dia: string } {
  const fmt = (zona: string) =>
    new Intl.DateTimeFormat('pt-BR', {
      timeZone: zona,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      // h23: meia-noite é "00", nunca "24".
      hourCycle: 'h23',
    }).formatToParts(new Date(iso))
  let ps: Intl.DateTimeFormatPart[]
  try {
    ps = fmt(tz || FUSO_PADRAO)
  } catch {
    ps = fmt(FUSO_PADRAO)
  }
  const p: Record<string, string> = {}
  for (const x of ps) p[x.type] = x.value
  return { hora: `${p.hour}:${p.minute}`, dia: `${p.day}/${p.month}` }
}

/**
 * A frase do aviso, no fuso da conta (como as outras do modal):
 * "Já há 'Avaliação' das 14:00 às 15:00 nesta agenda." Atravessando a
 * meia-noite, com o dia; dia inteiro, "o dia todo".
 */
export function avisoDeHorarioOcupado(c: HorarioOcupado, tz: string): string {
  const titulo = c.title.trim() || 'sem título'
  if (c.allDay) return `Já há '${titulo}' o dia todo nesta agenda.`
  const ini = partesNoFuso(c.startsAt, tz)
  const fim = partesNoFuso(c.endsAt, tz)
  if (ini.dia !== fim.dia) {
    return `Já há '${titulo}' das ${ini.hora} de ${ini.dia} às ${fim.hora} de ${fim.dia} nesta agenda.`
  }
  return `Já há '${titulo}' das ${ini.hora} às ${fim.hora} nesta agenda.`
}

// ---------- O modal: quando conferir e quando o salvar espera ----------

/**
 * Identifica UM horário numa agenda — o que foi conferido e o que a recepção
 * confirmou com "Salvar mesmo assim". Mudou a agenda, o início ou o fim: é
 * outro horário, confere de novo e pede de novo.
 */
export function chaveDoHorario(p: { calendarId: string; startsAt: string; endsAt: string }): string | null {
  const intervalo = intervaloDoPedido(p)
  if (!intervalo || !p.calendarId) return null
  return `${p.calendarId}|${new Date(intervalo.inicio).toISOString()}|${new Date(intervalo.fim).toISOString()}`
}

/** O pedido de volta a partir da chave (o efeito do modal só guarda a chave). */
export function pedidoDaChave(chave: string): { calendarId: string; startsAt: string; endsAt: string } | null {
  const [calendarId, startsAt, endsAt, ...resto] = chave.split('|')
  if (!calendarId || !startsAt || !endsAt || resto.length > 0) return null
  return { calendarId, startsAt, endsAt }
}

/**
 * O horário do formulário precisa ser conferido? Devolve a chave, ou null:
 * sem agenda escolhida, data ilegível, compromisso desmarcado (não ocupa
 * nada) ou EDIÇÃO que não mexeu na agenda nem no horário (`aberto` = a chave
 * do compromisso como abriu) — corrigir o título não pergunta nada.
 */
export function chaveParaConferir(args: {
  id: string | null
  status: string
  calendarId: string
  iso: { startsAt: string; endsAt: string } | null
  aberto: string | null
}): string | null {
  if (!args.calendarId || !args.iso || args.status === 'cancelled') return null
  const chave = chaveDoHorario({ calendarId: args.calendarId, ...args.iso })
  if (!chave) return null
  if (args.id && chave === args.aberto) return null
  return chave
}

/** O que o servidor respondeu para uma chave. `conflitos` null = a busca falhou. */
export type ConferenciaDoHorario = { chave: string; conflitos: HorarioOcupado[] | null }

export type SituacaoDoHorario =
  /** Nada a conferir (ver chaveParaConferir). */
  | { tipo: 'nada' }
  /** A resposta desta chave ainda não chegou: o salvar espera. */
  | { tipo: 'conferindo' }
  | { tipo: 'livre' }
  /** A busca falhou: diz no modal, mas NÃO trava — não bloquear é a regra. */
  | { tipo: 'naoConferido' }
  | { tipo: 'ocupado'; conflitos: HorarioOcupado[]; confirmado: boolean }

/**
 * Onde o horário do formulário está. `ignorar`: na remarcação, a consulta X
 * que este salvar MOVE — ela sai do horário antigo, não ocupa o novo.
 */
export function situacaoDoHorario(args: {
  chave: string | null
  conferencia: ConferenciaDoHorario | null
  /** A chave que a recepção confirmou com "Salvar mesmo assim". */
  confirmadoPara: string | null
  ignorar?: Array<string | null | undefined>
}): SituacaoDoHorario {
  const { chave, conferencia } = args
  if (!chave) return { tipo: 'nada' }
  if (!conferencia || conferencia.chave !== chave) return { tipo: 'conferindo' }
  if (conferencia.conflitos === null) return { tipo: 'naoConferido' }
  const ignorar = new Set((args.ignorar ?? []).filter((x): x is string => Boolean(x)))
  const conflitos = conferencia.conflitos.filter((c) => !ignorar.has(c.id))
  if (conflitos.length === 0) return { tipo: 'livre' }
  return { tipo: 'ocupado', conflitos, confirmado: args.confirmadoPara === chave }
}

/** O Salvar de sempre espera? Conferindo, ou ocupado sem o "Salvar mesmo assim". */
export function horarioTravaOSalvar(s: SituacaoDoHorario): boolean {
  return s.tipo === 'conferindo' || (s.tipo === 'ocupado' && !s.confirmado)
}
