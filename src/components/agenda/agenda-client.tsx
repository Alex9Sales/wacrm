'use client'

// ============================================================
// Agenda — cliente (visão de mês). Base interna; o sync Google e a
// integração com o agente de Follow-up entram por cima depois.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, Plus, X, Trash2, MapPin, RefreshCw, Link2, Unlink, User, AlertTriangle } from 'lucide-react'
import { ContactPicker } from '@/components/contacts/contact-picker'
import {
  avisoNaAgenda,
  rotuloDoBloqueio,
  type MeetingReminderBlock,
} from '@/lib/ai/meeting-reminder-block'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  listCalendars,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  getGoogleStatus,
  syncGoogleNow,
  disconnectGoogle,
  type CalendarRow,
  type EventRow,
  type GoogleStatus,
} from '@/app/(dashboard)/agenda/actions'
import { inkOn } from '@/lib/ui/ink-on'
import { cn } from '@/lib/utils'
import {
  WEEKDAYS,
  addDays,
  isSameDay,
  layoutDayEvents,
  monthGrid,
  pad,
  parseDateInput,
  parseLocalInput,
  scheduleError,
  shiftEndWithStart,
  startOfDay,
  toDateInput,
  toLocalInput,
  weekDays,
  weekRangeLabel,
} from './agenda-dates'

type View = 'month' | 'week' | 'day'

type Draft = {
  id: string | null
  title: string
  calendarId: string
  allDay: boolean
  start: string // datetime-local ou date
  end: string
  location: string
  description: string
  /**
   * Quem é o paciente/cliente do compromisso. Vazio = compromisso interno.
   * ⚠️ É ESTE campo que faz o lembrete sair: o follow-up procura o evento
   * pelo contact_id (`lib/ai/followup.ts`), não pelo título. Marcar sem
   * contato é marcar sem confirmação — foi o que manteve 157 de 158
   * consultas da Dra. Joyce sem aviso.
   */
  contactId: string
  /** Só leitura: por que o lembrete deste compromisso não saiu (null = saiu ou não travou). */
  reminderBlock: MeetingReminderBlock | null
}

export function AgendaClient() {
  const [anchor, setAnchor] = useState(() => new Date())
  const [calendars, setCalendars] = useState<CalendarRow[]>([])
  const [events, setEvents] = useState<EventRow[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [google, setGoogle] = useState<GoogleStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [view, setView] = useState<View>('month')
  /** Ver só UMA agenda (id) ou todas (null). Escolha da sessão, não é salva. */
  const [calendarFilter, setCalendarFilter] = useState<string | null>(null)
  /** Dia em foco nas visões Dia e Semana (a Semana mostra a semana dele). */
  const [dayDate, setDayDate] = useState<Date>(() => new Date())
  const viewRef = useRef(view)
  viewRef.current = view

  const grid = useMemo(() => monthGrid(anchor), [anchor])
  const week = useMemo(() => weekDays(dayDate), [dayDate])
  const today = useMemo(() => new Date(), [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const cals = await listCalendars()
      setCalendars(cals)
      const from = startOfDay(grid[0]).toISOString()
      const to = new Date(
        grid[41].getFullYear(),
        grid[41].getMonth(),
        grid[41].getDate(),
        23,
        59,
        59,
      ).toISOString()
      const evs = await listEvents({ from, to })
      setEvents(evs)
    } finally {
      setLoading(false)
    }
  }, [grid])

  useEffect(() => {
    void load()
  }, [load])

  // Auto-sync Google→CRM (sem precisar clicar Sincronizar): silencioso, com
  // throttle. Roda ao abrir, ao focar a aba e a cada 2 min.
  const lastAutoSync = useRef(0)
  const autoSync = useCallback(async () => {
    const now = Date.now()
    if (now - lastAutoSync.current < 45_000) return
    lastAutoSync.current = now
    try {
      const r = await syncGoogleNow()
      if (!r.error) await load()
    } catch {
      /* silencioso */
    }
  }, [load])

  useEffect(() => {
    if (!google?.connected) return
    void autoSync()
    const onFocus = () => {
      if (!document.hidden) void autoSync()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    const id = window.setInterval(() => void autoSync(), 120_000)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      window.clearInterval(id)
    }
  }, [google?.connected, autoSync])

  // Voltar do navegador no Dia ou na Semana retorna pro Mês (em vez de sair da página).
  useEffect(() => {
    const onPop = () => {
      if (viewRef.current !== 'month') setView('month')
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Estado da conexão Google + feedback do retorno do OAuth (?google=...).
  useEffect(() => {
    void getGoogleStatus().then(setGoogle).catch(() => {})
    const params = new URLSearchParams(window.location.search)
    const g = params.get('google')
    if (g === 'connected') {
      toast.success(`Google conectado${params.get('email') ? `: ${params.get('email')}` : ''}`)
      window.history.replaceState(null, '', '/agenda')
    } else if (g === 'error') {
      toast.error(`Falha ao conectar o Google: ${params.get('reason') ?? ''}`)
      window.history.replaceState(null, '', '/agenda')
    }
  }, [])

  // Vindo da conversa ("Marcar compromisso"): /agenda?contato=<id> abre o modal
  // já com a pessoa escolhida. Espera as agendas carregarem, senão o evento
  // nasceria na agenda local e a Dra. não veria no Google.
  const veioDaConversa = useRef(false)
  useEffect(() => {
    if (veioDaConversa.current || calendars.length === 0) return
    const contato = new URLSearchParams(window.location.search).get('contato')
    if (!contato) return
    veioDaConversa.current = true
    window.history.replaceState(null, '', '/agenda')
    openNew(undefined, undefined, contato)
    // openNew só depende de `calendars` (via defaultCalendarId).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendars])

  const onSyncGoogle = async () => {
    setSyncing(true)
    try {
      const r = await syncGoogleNow()
      if (r.error) toast.error(r.error)
      else {
        toast.success(`Sincronizado (${r.imported} novo(s) evento(s))`)
        await load()
      }
    } finally {
      setSyncing(false)
    }
  }

  const onDisconnectGoogle = async () => {
    // Um clique sem pergunta nenhuma parava a sincronização da clínica inteira —
    // e, até 30/09, ainda levava os compromissos junto. Quem clica aqui costuma
    // estar tentando CONSERTAR alguma coisa, não desligar a agenda.
    if (
      !window.confirm(
        'Desconectar o Google?\n\n' +
          'Os compromissos que já estão aqui continuam na agenda, mas o CRM para ' +
          'de receber o que for marcado no Google — e para de mandar o lembrete ' +
          'das consultas novas.\n\n' +
          'Para só atualizar agora, use "Sincronizar" em vez de desconectar.',
      )
    )
      return
    const r = await disconnectGoogle()
    if (r.error) toast.error(r.error)
    else {
      toast.success('Google desconectado')
      setGoogle((g) => (g ? { ...g, connected: false, email: null } : g))
      await load()
    }
  }

  const eventsForDay = useCallback(
    (day: Date): EventRow[] => {
      const s = startOfDay(day).getTime()
      const e = s + 86_400_000 - 1
      return events.filter((ev) => {
        if (calendarFilter && ev.calendarId !== calendarFilter) return false
        const es = new Date(ev.startsAt).getTime()
        const ee = new Date(ev.endsAt).getTime()
        return es <= e && ee >= s
      })
    },
    [events, calendarFilter],
  )

  // Novo evento cai numa agenda do Google por padrão (pra sincronizar); só usa a
  // local se não houver nenhuma do Google conectada.
  const defaultCalendarId = () =>
    (calendars.find((c) => c.source === 'google') ?? calendars[0])?.id ?? ''

  const openNew = (day?: Date, hour?: number, contactId = '') => {
    const base = day ?? new Date()
    const start = new Date(base)
    if (hour != null) start.setHours(hour, 0, 0, 0)
    else if (!day) start.setMinutes(0, 0, 0)
    else start.setHours(9, 0, 0, 0)
    const end = new Date(start)
    end.setHours(start.getHours() + 1)
    setDraft({
      id: null,
      title: '',
      calendarId: defaultCalendarId(),
      allDay: false,
      start: toLocalInput(start),
      end: toLocalInput(end),
      location: '',
      description: '',
      contactId,
      reminderBlock: null,
    })
  }

  const openEdit = (ev: EventRow) => {
    const s = new Date(ev.startsAt)
    const e = new Date(ev.endsAt)
    setDraft({
      id: ev.id,
      title: ev.title,
      calendarId: ev.calendarId,
      allDay: ev.allDay,
      start: ev.allDay ? toDateInput(s) : toLocalInput(s),
      end: ev.allDay ? toDateInput(e) : toLocalInput(e),
      location: ev.location ?? '',
      description: ev.description ?? '',
      contactId: ev.contactId ?? '',
      reminderBlock: ev.reminderBlock,
    })
  }

  const onToggleAllDay = (allDay: boolean) => {
    if (!draft) return
    if (allDay) {
      const s = new Date(draft.start)
      setDraft({ ...draft, allDay, start: toDateInput(s), end: toDateInput(s) })
    } else {
      const s = new Date(draft.start + 'T09:00')
      const e = new Date(draft.start + 'T10:00')
      setDraft({ ...draft, allDay, start: toLocalInput(s), end: toLocalInput(e) })
    }
  }

  const save = async () => {
    if (!draft || !draft.title.trim()) return
    // O botão já fica desligado e o erro aparece no formulário; isto é a trava.
    if (scheduleError(draft.start, draft.end, draft.allDay)) return
    setSaving(true)
    try {
      let startsAt: string
      let endsAt: string
      if (draft.allDay) {
        startsAt = new Date(draft.start + 'T00:00').toISOString()
        endsAt = new Date(draft.end + 'T23:59').toISOString()
      } else {
        startsAt = new Date(draft.start).toISOString()
        endsAt = new Date(draft.end).toISOString()
      }
      const payload = {
        title: draft.title,
        calendarId: draft.calendarId || null,
        allDay: draft.allDay,
        startsAt,
        endsAt,
        location: draft.location,
        description: draft.description,
        contactId: draft.contactId || null,
      }
      // Dia do evento (pra pular a visão pra lá e evitar confusão de mês/data).
      const eventDate = new Date(draft.start.slice(0, 10) + 'T12:00:00')
      if (draft.id) await updateEvent(draft.id, payload)
      else await createEvent(payload)
      setDraft(null)
      if (viewRef.current !== 'month') setDayDate(eventDate)
      const sameMonth =
        eventDate.getMonth() === anchor.getMonth() &&
        eventDate.getFullYear() === anchor.getFullYear()
      if (sameMonth) {
        await load() // mês não muda → recarrega a visão atual
      } else {
        // muda o mês → o efeito de load dispara sozinho e mostra o evento
        setAnchor(new Date(eventDate.getFullYear(), eventDate.getMonth(), 1))
      }
      toast.success(draft.id ? 'Evento atualizado.' : 'Evento criado.')
    } catch (err) {
      // Era try/finally SEM catch: falhando, o modal ficava aberto e nada
      // explicava (em produção o erro de Server Action chega sanitizado).
      console.error('[agenda] salvar falhou:', err)
      toast.error('Não foi possível salvar o evento. Tente de novo.')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!draft?.id) return
    // Apagar evento não tem desfazer — confirma antes (o botão era direto).
    if (!window.confirm(`Excluir o evento "${draft.title || 'sem título'}"? Não dá pra desfazer.`)) return
    setSaving(true)
    try {
      await deleteEvent(draft.id)
      setDraft(null)
      await load()
      toast.success('Evento excluído.')
    } catch (err) {
      console.error('[agenda] excluir falhou:', err)
      toast.error('Não foi possível excluir o evento.')
    } finally {
      setSaving(false)
    }
  }

  const monthLabel = anchor.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })

  // Abre a visão de Dia ou de Semana focada em `day`. O carregamento é o do
  // mês do dia focado: a grade de 42 dias desse mês sempre contém a semana
  // inteira dele (testado em agenda-dates.test.ts), então basta trocar o mês.
  const openTimeView = (next: 'day' | 'week', day: Date) => {
    setDayDate(day)
    if (day.getMonth() !== anchor.getMonth() || day.getFullYear() !== anchor.getFullYear()) {
      setAnchor(new Date(day.getFullYear(), day.getMonth(), 1))
    }
    // Empilha 1x ao SAIR do Mês (trocar Dia↔Semana ou de dia não empilha) →
    // o voltar do navegador sempre leva de volta pro Mês.
    if (viewRef.current === 'month') window.history.pushState({ agendaView: true }, '')
    setView(next)
  }
  const openDay = (day: Date) => openTimeView('day', day)
  const openWeek = (day: Date) => openTimeView('week', day)
  const backToMonth = () => {
    if (view !== 'month') window.history.back()
    else setView('month')
  }
  const shift = (delta: number) => {
    if (view === 'month') setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1))
    else openTimeView(view, addDays(dayDate, view === 'week' ? 7 * delta : delta))
  }
  const navToday = () => {
    const now = new Date()
    if (view === 'month') setAnchor(now)
    else openTimeView(view, now)
  }
  const headerLabel =
    view === 'month'
      ? monthLabel
      : view === 'week'
        ? weekRangeLabel(dayDate)
        : dayDate.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
  const viewButton = (active: boolean) =>
    cn(
      'px-3 py-1 text-xs font-medium',
      active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
    )

  return (
    <div className="flex flex-col gap-4">
      {/* Barra de navegação */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => shift(-1)} aria-label="Anterior">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={navToday}>
            Hoje
          </Button>
          <Button variant="outline" size="sm" onClick={() => shift(1)} aria-label="Próximo">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <h2
          className={cn(
            'font-heading text-lg font-semibold text-foreground',
            view !== 'week' && 'capitalize',
          )}
        >
          {headerLabel}
        </h2>
        {/* Alternância Mês / Semana / Dia. 01/10: a clínica pediu a Semana para
            ver a semana toda de uma vez, com as agendas dos profissionais. */}
        <div className="flex overflow-hidden rounded-lg ring-1 ring-border">
          <button type="button" onClick={backToMonth} className={viewButton(view === 'month')}>
            Mês
          </button>
          <button
            type="button"
            onClick={() => openWeek(view === 'month' ? new Date() : dayDate)}
            className={viewButton(view === 'week')}
          >
            Semana
          </button>
          <button
            type="button"
            onClick={() => openDay(view === 'month' ? new Date() : dayDate)}
            className={viewButton(view === 'day')}
          >
            Dia
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* Google Calendar */}
          {google?.connected ? (
            <div className="flex items-center gap-1.5">
              <span
                className="hidden max-w-[160px] truncate rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground md:inline"
                title={google.email ?? 'Google'}
              >
                {google.email ?? 'Google'}
              </span>
              <Button variant="outline" size="sm" onClick={onSyncGoogle} disabled={syncing}>
                <RefreshCw className={`mr-1.5 h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
                Sincronizar
              </Button>
              <Button variant="outline" size="sm" onClick={onDisconnectGoogle} title="Desconectar Google">
                <Unlink className="h-4 w-4" />
              </Button>
            </div>
          ) : google?.configured ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                window.location.href = '/api/google/calendar/connect'
              }}
            >
              <Link2 className="mr-1.5 h-4 w-4" /> Conectar Google
            </Button>
          ) : null}

          <Button size="sm" onClick={() => openNew()}>
            <Plus className="mr-1.5 h-4 w-4" /> Novo evento
          </Button>
        </div>
      </div>

      {/* Agendas — clicar filtra a grade para ver só aquela.
          30/09 (clínica da Dra. Joyce): assim que o Google reconectou, entraram
          as agendas dos 10 profissionais e o mês virou uma parede de eventos de
          todo mundo junto. A recepção precisa olhar UMA agenda por vez, que era
          o pedido do Rafael: "aparecer só os compromissos da Letícia". Era
          legenda — informação sem ação; agora é o filtro. */}
      {calendars.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {calendars.length > 1 && (
            <button
              type="button"
              onClick={() => setCalendarFilter(null)}
              className={cn(
                'rounded-full px-2 py-0.5 text-xs transition-colors',
                calendarFilter === null
                  ? 'bg-foreground/10 font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              Todas
            </button>
          )}
          {calendars.map((c) => {
            const ativa = calendarFilter === c.id
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setCalendarFilter(ativa ? null : c.id)}
                title={ativa ? `Mostrando só ${c.name} — clique para ver todas` : `Ver só ${c.name}`}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs transition-colors',
                  ativa
                    ? 'bg-foreground/10 font-medium text-foreground'
                    : calendarFilter === null
                      ? 'text-muted-foreground hover:bg-muted'
                      : 'text-muted-foreground/50 hover:bg-muted hover:text-muted-foreground',
                )}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c.color }} />
                {c.name}
              </button>
            )
          })}
        </div>
      )}

      {/* Grade do mês */}
      {view === 'month' && (
      <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
        <div className="grid grid-cols-7 border-b border-border bg-muted/40">
          {WEEKDAYS.map((w) => (
            <div key={w} className="px-2 py-2 text-center text-xs font-medium text-muted-foreground">
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {grid.map((day, i) => {
            const inMonth = day.getMonth() === anchor.getMonth()
            const isToday = isSameDay(day, today)
            const dayEvents = eventsForDay(day)
            return (
              <button
                key={i}
                type="button"
                onClick={() => openDay(day)}
                className={[
                  'group min-h-[104px] border-b border-r border-border p-1.5 text-left align-top transition-colors hover:bg-muted/40',
                  i % 7 === 0 ? 'border-l' : '',
                  inMonth ? 'bg-card' : 'bg-muted/20',
                ].join(' ')}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span
                    className={[
                      'inline-flex h-6 w-6 items-center justify-center rounded-full text-xs tabular-nums',
                      isToday
                        ? 'bg-primary font-semibold text-primary-foreground'
                        : inMonth
                          ? 'text-foreground'
                          : 'text-muted-foreground/50',
                    ].join(' ')}
                  >
                    {day.getDate()}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  {dayEvents.slice(0, 3).map((ev) => (
                    <span
                      key={ev.id}
                      onClick={(e) => {
                        e.stopPropagation()
                        openEdit(ev)
                      }}
                      className="flex items-center gap-1 truncate rounded px-1 py-0.5 text-[11px] font-medium"
                      style={{ background: ev.calendarColor, color: inkOn(ev.calendarColor) }}
                      title={
                        ev.reminderBlock
                          ? `${ev.title}${ev.contactName ? ` — ${ev.contactName}` : ''}: ${avisoNaAgenda(ev.reminderBlock)}`
                          : ev.contactName
                            ? `${ev.title} — ${ev.contactName}`
                            : ev.title
                      }
                    >
                      {/* A Agenda ABRE no mês: um compromisso cujo paciente não
                          foi avisado tem que dar sinal aqui, senão o aviso só
                          existe para quem já foi procurar na visão de dia. */}
                      {ev.reminderBlock && <AlertTriangle className="h-3 w-3 shrink-0" />}
                      {!ev.allDay && (
                        <span className="tabular-nums opacity-90">
                          {pad(new Date(ev.startsAt).getHours())}:{pad(new Date(ev.startsAt).getMinutes())}
                        </span>
                      )}
                      <span className="truncate">{ev.title}</span>
                    </span>
                  ))}
                  {dayEvents.length > 3 && (
                    <span className="px-1 text-[11px] text-muted-foreground">
                      +{dayEvents.length - 3} mais
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>
      )}

      {/* Visões de dia e de semana (grade de horários) */}
      {view !== 'month' && (
        <TimeGrid
          days={view === 'week' ? week : [dayDate]}
          today={today}
          eventsForDay={eventsForDay}
          onNewAt={openNew}
          onEdit={openEdit}
          onOpenDay={openDay}
        />
      )}

      {loading && <p className="text-center text-sm text-muted-foreground">Carregando…</p>}

      {/* Modal criar/editar */}
      {draft && (
        <EventModal
          draft={draft}
          setDraft={setDraft}
          calendars={calendars}
          saving={saving}
          onToggleAllDay={onToggleAllDay}
          onSave={save}
          onDelete={remove}
          onClose={() => setDraft(null)}
        />
      )}
    </div>
  )
}

const HOUR_H = 48

/** O que aparece ao passar o mouse num compromisso da grade de horas. */
function eventTooltip(ev: EventRow): string {
  return ev.reminderBlock
    ? `${ev.title}${ev.contactName ? ` — ${ev.contactName}` : ''}: ${avisoNaAgenda(ev.reminderBlock)}`
    : ev.contactName
      ? `${ev.title} — ${ev.contactName} (recebe a confirmação)`
      : `${ev.title} — sem cliente/paciente: ninguém é avisado`
}

/**
 * Grade de horas das visões Dia (1 coluna) e Semana (7 colunas).
 * Uma rolagem só, nos dois sentidos: no celular a Semana rola de lado DENTRO
 * da grade (a página não), com a coluna das horas e o cabeçalho dos dias
 * grudados na borda.
 */
function TimeGrid({
  days,
  today,
  eventsForDay,
  onNewAt,
  onEdit,
  onOpenDay,
}: {
  days: Date[]
  today: Date
  eventsForDay: (day: Date) => EventRow[]
  onNewAt: (day: Date, hour: number) => void
  onEdit: (ev: EventRow) => void
  /** Semana: clicar no cabeçalho (ou no "+N") abre aquele dia. */
  onOpenDay: (day: Date) => void
}) {
  const isWeek = days.length > 1
  const scrollRef = useRef<HTMLDivElement>(null)
  const firstDay = days[0].getTime()
  // Abre já no horário comercial (~7h) em vez da meia-noite.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_H
  }, [firstDay, days.length])

  const columns = days.map((day) => {
    const evs = eventsForDay(day)
    return {
      day,
      allDay: evs.filter((e) => e.allDay),
      slots: layoutDayEvents(
        evs.filter((e) => !e.allDay),
        day,
      ),
    }
  })
  const hasAllDay = columns.some((c) => c.allDay.length > 0)

  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
      <div ref={scrollRef} className="max-h-[560px] overflow-auto bg-card">
        <div className={isWeek ? 'min-w-[728px]' : undefined}>
          {(isWeek || hasAllDay) && (
            <div className="sticky top-0 z-20 border-b border-border bg-card">
              {isWeek && (
                <div className="flex">
                  <div className="sticky left-0 z-10 w-14 shrink-0 bg-card" />
                  {days.map((day) => {
                    const isToday = isSameDay(day, today)
                    return (
                      <button
                        key={day.getTime()}
                        type="button"
                        onClick={() => onOpenDay(day)}
                        title={`Abrir ${day.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}`}
                        className="flex min-w-0 flex-1 flex-col items-center gap-0.5 border-l border-border/50 py-1.5 transition-colors hover:bg-muted/40"
                      >
                        <span
                          className={cn(
                            'text-[11px] font-medium',
                            isToday ? 'text-primary' : 'text-muted-foreground',
                          )}
                        >
                          {WEEKDAYS[day.getDay()]}
                        </span>
                        <span
                          className={cn(
                            'inline-flex h-7 w-7 items-center justify-center rounded-full text-sm tabular-nums',
                            isToday ? 'bg-primary font-semibold text-primary-foreground' : 'text-foreground',
                          )}
                        >
                          {day.getDate()}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
              {hasAllDay && (
                <div className={cn('flex', isWeek && 'border-t border-border/50')}>
                  <div className="sticky left-0 z-10 flex w-14 shrink-0 items-center bg-card px-1.5 text-[10px] leading-tight text-muted-foreground">
                    dia todo
                  </div>
                  {columns.map(({ day, allDay }) => (
                    <div
                      key={day.getTime()}
                      className={cn(
                        'flex min-w-0 flex-1 gap-1 border-l border-border/50 p-1',
                        isWeek ? 'flex-col' : 'flex-wrap',
                      )}
                    >
                      {(isWeek ? allDay.slice(0, 3) : allDay).map((ev) => (
                        <button
                          key={ev.id}
                          type="button"
                          onClick={() => onEdit(ev)}
                          className="max-w-full truncate rounded px-2 py-0.5 text-left text-xs font-medium"
                          style={{ background: ev.calendarColor, color: inkOn(ev.calendarColor) }}
                          title={ev.title}
                        >
                          {ev.title}
                        </button>
                      ))}
                      {isWeek && allDay.length > 3 && (
                        <button
                          type="button"
                          onClick={() => onOpenDay(day)}
                          className="px-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          +{allDay.length - 3} mais
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex" style={{ height: 24 * HOUR_H }}>
            {/* coluna das horas */}
            <div className="sticky left-0 z-10 w-14 shrink-0 bg-card">
              {Array.from({ length: 24 }, (_, h) => (
                <span
                  key={h}
                  className="absolute left-1.5 text-[11px] tabular-nums text-muted-foreground"
                  style={{ top: h * HOUR_H + 2 }}
                >
                  {pad(h)}:00
                </span>
              ))}
            </div>
            {columns.map(({ day, slots }) => (
              <div
                key={day.getTime()}
                className={cn(
                  'relative min-w-0 flex-1 border-l border-border/50',
                  isWeek && isSameDay(day, today) && 'bg-primary/5',
                )}
              >
                {/* faixas de hora (clique cria evento naquele dia e horário) */}
                {Array.from({ length: 24 }, (_, h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => onNewAt(day, h)}
                    className="absolute inset-x-0 border-b border-border/50 transition-colors hover:bg-muted/40"
                    style={{ top: h * HOUR_H, height: HOUR_H }}
                    aria-label={`Criar ${isWeek ? `${WEEKDAYS[day.getDay()]} ${day.getDate()} ` : ''}às ${pad(h)}:00`}
                  />
                ))}
                {/* eventos posicionados por horário; quem se sobrepõe divide a largura */}
                {slots.map(({ event: ev, startMin, endMin, col, cols }) => {
                  const s = new Date(ev.startsAt)
                  const durMin = Math.max(30, endMin - startMin)
                  return (
                    <div
                      key={ev.id}
                      onClick={() => onEdit(ev)}
                      className={cn(
                        'absolute cursor-pointer overflow-hidden rounded-md shadow-sm',
                        isWeek ? 'px-1.5 py-0.5 text-[11px] leading-tight' : 'px-2 py-1 text-xs',
                      )}
                      style={{
                        top: (startMin / 60) * HOUR_H + 1,
                        height: Math.max(20, (durMin / 60) * HOUR_H - 2),
                        left: `calc(${(col / cols) * 100}% + 2px)`,
                        width: `calc(${100 / cols}% - 4px)`,
                        background: ev.calendarColor,
                        color: inkOn(ev.calendarColor),
                      }}
                      title={eventTooltip(ev)}
                    >
                      {/* Fora do bloco do nome de propósito: uma consulta de 30 min é
                          baixa demais para mostrar o nome, e era justamente nela que
                          o alerta sumia. O aviso não pode depender da duração. */}
                      {ev.reminderBlock && <AlertTriangle className="mr-1 inline h-3 w-3" />}
                      <span className="font-medium tabular-nums">
                        {pad(s.getHours())}:{pad(s.getMinutes())}
                      </span>{' '}
                      {ev.title}
                      {/* Com quem é o compromisso, quando há altura pra mostrar. Quem
                          olha a agenda quer ver a PESSOA, não só o título. */}
                      {ev.contactName && durMin >= 45 && (
                        <div className="truncate opacity-80">
                          <User className="mr-1 inline h-3 w-3" />
                          {ev.contactName}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function EventModal({
  draft,
  setDraft,
  calendars,
  saving,
  onToggleAllDay,
  onSave,
  onDelete,
  onClose,
}: {
  draft: Draft
  setDraft: (d: Draft) => void
  calendars: CalendarRow[]
  saving: boolean
  onToggleAllDay: (v: boolean) => void
  onSave: () => void
  onDelete: () => void
  onClose: () => void
}) {
  // Mudou o início → o fim anda junto, com a mesma duração (shiftEndWithStart).
  // O campo devolve "" enquanto a pessoa digita a data; guarda o último
  // início válido para a duração não se perder no meio da digitação.
  const lastValidStart = useRef(draft.start)
  const parseStart = draft.allDay ? parseDateInput : parseLocalInput
  const changeStart = (value: string) => {
    const prev = parseStart(draft.start) ? draft.start : lastValidStart.current
    if (parseStart(value)) lastValidStart.current = value
    setDraft({ ...draft, start: value, end: shiftEndWithStart(prev, draft.end, value, draft.allDay) })
  }
  const timeError = scheduleError(draft.start, draft.end, draft.allDay)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-heading text-base font-semibold">
            {draft.id ? 'Editar evento' : 'Novo evento'}
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex flex-col gap-3">
          {/* O lembrete deste compromisso não conseguiu sair. Fica no ALTO do
              formulário, com o que fazer — antes isso não aparecia em lugar
              nenhum e o paciente simplesmente não era avisado. */}
          {draft.reminderBlock && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="min-w-0 text-xs">
                <p className="font-medium text-foreground">
                  Este contato não recebeu a confirmação —{' '}
                  {rotuloDoBloqueio(draft.reminderBlock).curto}.
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {rotuloDoBloqueio(draft.reminderBlock).explicacao}
                </p>
                <p className="mt-1 text-foreground/80">
                  {rotuloDoBloqueio(draft.reminderBlock).comoResolver}
                </p>
              </div>
            </div>
          )}

          <div>
            <Label className="mb-1 block text-xs">Título</Label>
            <Input
              autoFocus
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="Ex.: Reunião com cliente"
            />
          </div>

          <div>
            <Label className="mb-1 block text-xs">
              <User className="mr-1 inline h-3 w-3" />
              Cliente / paciente
            </Label>
            <ContactPicker
              value={draft.contactId}
              onChange={(contactId, contact) =>
                setDraft({
                  ...draft,
                  contactId,
                  // Título em branco ganha o nome de quem é — o atendente digita
                  // o mínimo e o compromisso já fica reconhecível na agenda.
                  title: draft.title || (contact?.name ? contact.name : draft.title),
                })
              }
              placeholder="Buscar por nome ou telefone..."
            />
            {/* Campo que, em branco, desliga o lembrete em silêncio: diz isso aqui,
                no lugar, e não num toast que some. */}
            <p className="mt-1 text-[11px] text-muted-foreground">
              {draft.contactId ? (
                <>
                  Quem estiver aqui <strong>recebe a confirmação</strong> da consulta pelo
                  WhatsApp, se os lembretes do agente estiverem ligados.
                </>
              ) : (
                <>
                  Sem preencher, o compromisso entra na agenda mas{' '}
                  <strong>ninguém é avisado</strong> — o lembrete procura a pessoa por
                  este campo.
                </>
              )}
            </p>
          </div>

          <div>
            <Label className="mb-1 block text-xs">Agenda</Label>
            <select
              value={draft.calendarId}
              onChange={(e) => setDraft({ ...draft, calendarId: e.target.value })}
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            >
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.source === 'google' ? ' · Google (sincroniza)' : ' · local (não sincroniza)'}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Agendas do Google sincronizam nos dois sentidos. A agenda local fica só no CRM.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Switch checked={draft.allDay} onCheckedChange={onToggleAllDay} />
            Dia inteiro
          </label>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="mb-1 block text-xs">Início</Label>
              <input
                type={draft.allDay ? 'date' : 'datetime-local'}
                value={draft.start}
                onFocus={() => {
                  if (parseStart(draft.start)) lastValidStart.current = draft.start
                }}
                onChange={(e) => changeStart(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              />
            </div>
            <div>
              <Label className="mb-1 block text-xs">Fim</Label>
              <input
                type={draft.allDay ? 'date' : 'datetime-local'}
                value={draft.end}
                min={draft.start || undefined}
                aria-invalid={timeError ? true : undefined}
                onChange={(e) => setDraft({ ...draft, end: e.target.value })}
                className={cn(
                  'h-9 w-full rounded-md border border-border bg-background px-2 text-sm',
                  timeError && 'border-destructive',
                )}
              />
            </div>
          </div>
          {/* No lugar, e não num toast que some: sem isso o Salvar só fica
              cinza e ninguém sabe por quê. */}
          {timeError && (
            <p role="alert" className="-mt-1 flex items-start gap-1 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              {timeError}
            </p>
          )}

          <div>
            <Label className="mb-1 block text-xs">
              <MapPin className="mr-1 inline h-3 w-3" />
              Local
            </Label>
            <Input
              value={draft.location}
              onChange={(e) => setDraft({ ...draft, location: e.target.value })}
              placeholder="Opcional"
            />
          </div>

          <div>
            <Label className="mb-1 block text-xs">Descrição</Label>
            <Textarea
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              rows={3}
              placeholder="Opcional"
            />
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between">
          {draft.id ? (
            <Button variant="outline" onClick={onDelete} disabled={saving}>
              <Trash2 className="mr-1.5 h-4 w-4 text-red-500" /> Excluir
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={onSave} disabled={saving || !draft.title.trim() || !!timeError}>
              {saving ? 'Salvando…' : 'Salvar'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
