'use client'

// ============================================================
// Agenda — cliente (visão de mês). Base interna; o sync Google e a
// integração com o agente de Follow-up entram por cima depois.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, Plus, X, Trash2, MapPin, RefreshCw, Link2, Unlink } from 'lucide-react'
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

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

const pad = (n: number) => String(n).padStart(2, '0')
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function monthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const start = new Date(first)
  start.setDate(1 - first.getDay()) // volta até o domingo
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

type Draft = {
  id: string | null
  title: string
  calendarId: string
  allDay: boolean
  start: string // datetime-local ou date
  end: string
  location: string
  description: string
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

  const grid = useMemo(() => monthGrid(anchor), [anchor])
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
        const es = new Date(ev.startsAt).getTime()
        const ee = new Date(ev.endsAt).getTime()
        return es <= e && ee >= s
      })
    },
    [events],
  )

  const openNew = (day?: Date) => {
    const base = day ?? new Date()
    const start = new Date(base)
    if (!day) start.setMinutes(0, 0, 0)
    else start.setHours(9, 0, 0, 0)
    const end = new Date(start)
    end.setHours(start.getHours() + 1)
    setDraft({
      id: null,
      title: '',
      calendarId: calendars[0]?.id ?? '',
      allDay: false,
      start: toLocalInput(start),
      end: toLocalInput(end),
      location: '',
      description: '',
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
      }
      if (draft.id) await updateEvent(draft.id, payload)
      else await createEvent(payload)
      setDraft(null)
      await load()
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!draft?.id) return
    setSaving(true)
    try {
      await deleteEvent(draft.id)
      setDraft(null)
      await load()
    } finally {
      setSaving(false)
    }
  }

  const monthLabel = anchor.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })

  return (
    <div className="flex flex-col gap-4">
      {/* Barra de navegação */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}
            aria-label="Mês anterior"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAnchor(new Date())}>
            Hoje
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}
            aria-label="Próximo mês"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <h2 className="font-heading text-lg font-semibold capitalize text-foreground">
          {monthLabel}
        </h2>
        <div className="ml-auto flex items-center gap-2">
          {/* Legenda das agendas */}
          <div className="hidden items-center gap-3 sm:flex">
            {calendars.map((c) => (
              <span key={c.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.color }} />
                {c.name}
              </span>
            ))}
          </div>
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

      {/* Grade do mês */}
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
                onClick={() => openNew(day)}
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
                      className="flex items-center gap-1 truncate rounded px-1 py-0.5 text-[11px] text-white"
                      style={{ background: ev.calendarColor }}
                      title={ev.title}
                    >
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
            <Label className="mb-1 block text-xs">Agenda</Label>
            <select
              value={draft.calendarId}
              onChange={(e) => setDraft({ ...draft, calendarId: e.target.value })}
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            >
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
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
                onChange={(e) => setDraft({ ...draft, start: e.target.value })}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              />
            </div>
            <div>
              <Label className="mb-1 block text-xs">Fim</Label>
              <input
                type={draft.allDay ? 'date' : 'datetime-local'}
                value={draft.end}
                onChange={(e) => setDraft({ ...draft, end: e.target.value })}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              />
            </div>
          </div>

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
            <Button onClick={onSave} disabled={saving || !draft.title.trim()}>
              {saving ? 'Salvando…' : 'Salvar'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
