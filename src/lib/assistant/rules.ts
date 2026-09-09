// ============================================================
// 🤝 Assistente do dono — parte PURA (Fase 3a, 08/09/2026).
//
// O dono/admin fala com o número da empresa e o CRM responde por ele:
// leitura na hora (funil parado, resumo, cliente, agenda, cobranças, equipe)
// e escrita com proposta + SIM (tarefa, atribuir, agendar). Cobrança já tem
// o próprio comando (lib/collections/owner-command.ts) e passa na frente.
//
// Aqui: o que pode ser testado sem banco — filtro de "é pedido pro CRM?",
// normalização do JSON do modelo, datas/horas no fuso da conta e os textos.
// Sem imports de banco/Redis.
// ============================================================

import { parseDueDate } from '@/lib/collections/emit-rules'

export const ASSISTANT_KINDS = [
  'stalled_deals',
  'summary',
  'find_customer',
  'agenda',
  'collections',
  'team',
  'create_task',
  'assign',
  'create_event',
  'help',
  'other',
] as const
export type AssistantKind = (typeof ASSISTANT_KINDS)[number]

export interface AssistantIntent {
  kind: AssistantKind
  /** Cliente/lead citado ("João Silva", "Maria da padaria"). */
  customer: string | null
  /** Pessoa da equipe citada ("Vitor"). */
  assignee: string | null
  /** Título curto da tarefa/compromisso. */
  title: string | null
  /** Quando, como veio ("amanhã", "sexta", "10/09", "+2"). */
  when: string | null
  /** Hora "HH:MM" quando citada. */
  time: string | null
  /** Duração em minutos (compromisso). */
  duration: number | null
}

const REQUEST_RE =
  /\b(funil|neg[óo]cios?|parad[oa]s?|esfriando|sem resposta|resumo|panorama|como (estamos|est[áa])|agenda|compromissos?|marca|marcar|agendar|agende|reuni[ãa]o|visita|consulta|tarefa|lembra|lembrete|atribui|atribuir|transfere|transferir|passa|passar|repassa|manda (pro|pra|para)|quem|quantos|quantas|cliente|cadastro|contato|hist[óo]rico|cobran[çc]as?|devendo|inadimpl\w*|pagou|pagaram|entrou|recebemos|equipe|atendimentos?|atendeu|esperando|fila|ajuda|o que voc[êe] (faz|sabe)|me mostra|me lista|lista|tenho|amanh[ãa]|hoje|semana|hor[áa]rios?|pr[óo]xim[ao]s?)\b/i

/** Barato: só chama o modelo quando o texto parece pedido pro CRM. */
export function looksLikeAssistantRequest(text: string): boolean {
  const t = (text ?? '').trim()
  if (t.length < 3) return false
  return REQUEST_RE.test(t)
}

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s && s.toLowerCase() !== 'null' ? s : null
}

/** Valida o JSON do modelo; kind fora da lista → null (quem chamou deixa passar pra IA de vendas). */
export function normalizeIntent(raw: unknown): AssistantIntent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = typeof r.kind === 'string' ? (r.kind.trim() as AssistantKind) : null
  if (!kind || !(ASSISTANT_KINDS as readonly string[]).includes(kind)) return null
  const duration = r.duration == null ? null : Math.trunc(Number(r.duration))
  let time = str(r.time)
  if (time) {
    const m = /^(\d{1,2})(?::(\d{2}))?/.exec(time)
    time = m ? `${String(Math.min(23, Number(m[1]))).padStart(2, '0')}:${(m[2] ?? '00').padStart(2, '0')}` : null
  }
  return {
    kind,
    customer: str(r.customer),
    assignee: str(r.assignee),
    title: str(r.title),
    when: str(r.when),
    time,
    duration: Number.isFinite(duration) && duration != null && duration > 0 && duration <= 24 * 60 ? duration : null,
  }
}

// ---------------------------------------------------------------- tempo

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  terça: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
  sábado: 6,
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * "amanhã", "sexta", "10/09", "dia 10", "+2", "hoje" → 'YYYY-MM-DD' (calendário
 * de `today`, que deve ser o "hoje" no fuso da conta). Dia da semana = a
 * próxima ocorrência (hoje conta se for o mesmo dia).
 */
export function parseWhenDate(raw: string | null | undefined, today: Date): string | null {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return null
  if (/^hoje$/.test(s)) return ymd(today)
  if (/depois de amanh[ãa]/.test(s)) return parseDueDate('+2', today)
  if (/amanh[ãa]/.test(s)) return parseDueDate('+1', today)
  const wd = Object.keys(WEEKDAYS).find((k) => new RegExp(`\\b${k}(-feira)?\\b`).test(s))
  if (wd) {
    const target = WEEKDAYS[wd]
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    let delta = (target - base.getDay() + 7) % 7
    if (/pr[óo]xim[ao]/.test(s) && delta === 0) delta = 7
    base.setDate(base.getDate() + delta)
    return ymd(base)
  }
  if (/pr[óo]xima semana|semana que vem/.test(s)) return parseDueDate('+7', today)
  return parseDueDate(s, today)
}

/** "14h", "14:30", "às 15", "9 da manhã", "3 da tarde" → 'HH:MM'. */
export function parseTime(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return null
  const m = /(?:^|\D)(\d{1,2})(?::(\d{2}))?\s*(h(?:oras)?|da manh[ãa]|da tarde|da noite)?\b/.exec(s)
  if (!m) return null
  let h = Number(m[1])
  const mi = m[2] ?? '00'
  if (h > 23) return null
  if ((m[3] === 'da tarde' || m[3] === 'da noite') && h < 12) h += 12
  return `${String(h).padStart(2, '0')}:${mi}`
}

/** Deslocamento do fuso (min) num instante — via Intl, sem biblioteca. */
export function tzOffsetMinutes(tz: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at)
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
    const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name)
    if (!m) return 0
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0))
  } catch {
    return 0
  }
}

/** 'YYYY-MM-DD' + 'HH:MM' no fuso da conta → ISO UTC. */
export function zonedIso(date: string, time: string, tz: string): string {
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const off = tzOffsetMinutes(tz, new Date(guess))
  return new Date(guess - off * 60_000).toISOString()
}

/** "Hoje" no fuso da conta como Date local (só ano/mês/dia importam). */
export function todayInTz(tz: string, now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  return new Date(get('year'), get('month') - 1, get('day'))
}

export function fmtDateTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    .format(new Date(iso))
    .replace('.,', '')
    .replace(',', '')
}

export function fmtDate(ymdStr: string): string {
  return ymdStr.slice(0, 10).split('-').reverse().join('/')
}

export const brl = (n: number, currency = 'BRL') =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: currency || 'BRL' })

// ---------------------------------------------------------------- textos

export function helpText(): string {
  return [
    'Sou o assistente da sua conta. Posso:',
    '• Funil: "o que tem parado?", "resumo de hoje"',
    '• Cliente: "acha o João Silva", "histórico da Maria"',
    '• Agenda: "o que tenho amanhã?", "agenda da semana"',
    '• Cobranças: "quem está devendo?", "quanto entrou?"',
    '• Equipe: "quem está esperando resposta?", "atendimentos de hoje"',
    '• Tarefa: "me lembra sexta de ligar pro Carlos"',
    '• Atribuir: "passa o João Silva pro Vitor"',
    '• Agendar: "marca reunião com a Ana amanhã às 15h"',
    '• Cobrança: "cria uma cobrança de 150 pro João vencendo dia 10"',
    'Tudo que muda algo eu confirmo antes: respondo com a proposta e você diz SIM.',
  ].join('\n')
}

export interface StalledDealRow {
  title: string
  contact: string | null
  stage: string | null
  value: number
  currency: string | null
  days: number
  assignee: string | null
}

export function formatStalledDeals(rows: StalledDealRow[], total: number, staleDays: number): string {
  if (!rows.length) return `Nada parado há mais de ${staleDays} dias no funil. 👌`
  const lines = rows.map(
    (r) =>
      `• ${r.contact ?? r.title} — ${brl(r.value, r.currency ?? 'BRL')} · ${r.stage ?? 'sem etapa'} · ${r.days}d parado${r.assignee ? ` · ${r.assignee}` : ' · sem responsável'}`,
  )
  const head = `${total} negócio${total === 1 ? '' : 's'} parado${total === 1 ? '' : 's'} há mais de ${staleDays} dias${total > rows.length ? ` (mostrando ${rows.length})` : ''}:`
  return [head, ...lines].join('\n')
}

export interface CustomerCard {
  name: string | null
  phone: string
  email: string | null
  deals: { title: string; stage: string | null; value: number; currency: string | null; status: string | null }[]
  lastConversation: { channel: string | null; at: string | null; status: string | null } | null
  openChargesCount: number
  openChargesTotal: number
}

export function formatCustomerCard(c: CustomerCard, tz: string): string {
  const lines = [`${c.name ?? 'Sem nome'} · ${c.phone}${c.email ? ` · ${c.email}` : ''}`]
  if (c.deals.length) {
    lines.push('Negócios:')
    for (const d of c.deals.slice(0, 4)) {
      lines.push(`• ${d.title} — ${brl(d.value, d.currency ?? 'BRL')} · ${d.stage ?? '—'}${d.status && d.status !== 'open' ? ` · ${d.status === 'won' ? 'ganho' : 'perdido'}` : ''}`)
    }
  } else {
    lines.push('Sem negócio no funil.')
  }
  if (c.lastConversation?.at) {
    lines.push(`Última conversa: ${fmtDateTime(c.lastConversation.at, tz)}${c.lastConversation.channel ? ` (${c.lastConversation.channel})` : ''}${c.lastConversation.status === 'resolved' ? ' · resolvida' : ''}`)
  }
  if (c.openChargesCount) lines.push(`Cobranças em aberto: ${c.openChargesCount} · ${brl(c.openChargesTotal)}`)
  return lines.join('\n')
}

export function formatCustomerChoices(list: { name: string | null; phone: string }[]): string {
  return ['Achei mais de um. Qual?', ...list.map((c, i) => `${i + 1}) ${c.name ?? 'Sem nome'} · ${c.phone}`), 'Repita o pedido com o nome completo ou o telefone.'].join('\n')
}

export interface AgendaEvent {
  title: string
  startsAt: string
  endsAt: string
  allDay: boolean
  contact: string | null
}

export function formatAgenda(events: AgendaEvent[], tz: string, label: string): string {
  if (!events.length) return `Nada na agenda ${label}.`
  const lines = events.map((e) => {
    const when = e.allDay ? `${fmtDate(e.startsAt.slice(0, 10))} (dia todo)` : fmtDateTime(e.startsAt, tz)
    return `• ${when} — ${e.title}${e.contact ? ` · ${e.contact}` : ''}`
  })
  return [`Agenda ${label}:`, ...lines].join('\n')
}

export interface CollectionsSnapshot {
  openCount: number
  openTotal: number
  overdueCount: number
  overdueTotal: number
  paid7Count: number
  paid7Total: number
  topDebtors: { name: string; total: number; days: number }[]
}

export function formatCollections(s: CollectionsSnapshot): string {
  const lines = [
    `Em aberto: ${s.openCount} cobrança${s.openCount === 1 ? '' : 's'} · ${brl(s.openTotal)}`,
    `Vencidas: ${s.overdueCount} · ${brl(s.overdueTotal)}`,
    `Recebido nos últimos 7 dias: ${s.paid7Count} · ${brl(s.paid7Total)}`,
  ]
  if (s.topDebtors.length) {
    lines.push('Maiores devedores:')
    for (const d of s.topDebtors) lines.push(`• ${d.name} — ${brl(d.total)} · ${d.days}d vencida`)
  }
  return lines.join('\n')
}

export interface TeamSnapshot {
  /** sentToday = conversas com resposta humana hoje atribuídas à pessoa. */
  members: { name: string; openConversations: number; sentToday: number }[]
  /** Conversas respondidas hoje SEM responsável (ninguém assumiu). */
  unassignedAnswered?: number
  waiting: { name: string; minutes: number; assignee: string | null }[]
}

export function formatTeam(t: TeamSnapshot): string {
  const lines: string[] = []
  if (t.members.length) {
    lines.push('Equipe hoje:')
    for (const m of t.members) {
      const done = m.sentToday === 1 ? '1 conversa atendida' : `${m.sentToday} conversas atendidas`
      const convs = m.openConversations === 1 ? '1 aberta' : `${m.openConversations} abertas`
      lines.push(`• ${m.name} — ${done} · ${convs}`)
    }
    if (t.unassignedAnswered) lines.push(`• Sem responsável — ${t.unassignedAnswered} conversa${t.unassignedAnswered === 1 ? '' : 's'} atendida${t.unassignedAnswered === 1 ? '' : 's'} (ninguém assumiu)`)
  }
  if (t.waiting.length) {
    lines.push(`Esperando resposta há mais de 1h (${t.waiting.length}):`)
    for (const w of t.waiting.slice(0, 6)) lines.push(`• ${w.name} — ${Math.round(w.minutes / 60)}h${w.assignee ? ` · ${w.assignee}` : ' · sem responsável'}`)
  } else {
    lines.push('Ninguém esperando resposta há mais de 1h. 👌')
  }
  return lines.join('\n')
}

export function formatTaskProposal(p: { title: string; dueLabel: string | null; assigneeName: string | null; contactName: string | null }): string {
  return `Confirma? Criar tarefa "${p.title}"${p.dueLabel ? ` para ${p.dueLabel}` : ''}${p.assigneeName ? ` com ${p.assigneeName}` : ''}${p.contactName ? ` (cliente ${p.contactName})` : ''}. Responda SIM ou NÃO.`
}

export function formatAssignProposal(p: { what: string; label: string; toName: string }): string {
  return `Confirma? Passar ${p.what} "${p.label}" para ${p.toName}. Responda SIM ou NÃO.`
}

export function formatEventProposal(p: { title: string; startLabel: string; endLabel: string; contactName: string | null }): string {
  return `Confirma? Marcar "${p.title}" ${p.startLabel} até ${p.endLabel}${p.contactName ? ` com ${p.contactName}` : ''}. Responda SIM ou NÃO.`
}
