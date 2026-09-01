'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  listScheduled,
  getScheduledCounts,
  reassignScheduled,
  retryScheduled,
  type ScheduledRow,
  type SchedCounts,
  type SchedStatus,
} from './actions'
import { cancelScheduledMessage } from '@/app/(dashboard)/inbox/schedule-actions'
import { listTeamMembers } from '@/app/(dashboard)/internal-chat/actions'
import { ScheduleMessageDialog } from '@/components/agendamentos/schedule-message-dialog'
import { BrokenChannelAlert } from '@/components/agendamentos/broken-channel-alert'
import { useAuth } from '@/hooks/use-auth'
import { hasMinRole } from '@/lib/auth/roles'
import { Input } from '@/components/ui/input'
import {
  CalendarClock,
  Clock,
  Search,
  MessageSquare,
  ExternalLink,
  X,
  RotateCw,
  Loader2,
  UserCog,
  AlertTriangle,
} from 'lucide-react'

type Member = { id: string; name: string | null }

const STATUS_TABS: { key: SchedStatus | 'all'; label: string }[] = [
  { key: 'pending', label: 'A enviar' },
  { key: 'sent', label: 'Enviadas' },
  { key: 'cancelled', label: 'Canceladas' },
  { key: 'failed', label: 'Falhas' },
]

const STATUS_BADGE: Record<SchedStatus, string> = {
  pending: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  sent: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  cancelled: 'bg-muted text-muted-foreground',
  failed: 'bg-red-500/10 text-red-600 dark:text-red-400',
}
const STATUS_TEXT: Record<SchedStatus, string> = {
  pending: 'A enviar',
  sent: 'Enviada',
  cancelled: 'Cancelada',
  failed: 'Falhou',
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}
function absTime(iso: string) {
  const d = new Date(iso)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
/** Tempo relativo amigável para pendentes ("em 2h", "amanhã 09:00", "atrasada"). */
function relTime(iso: string) {
  const t = new Date(iso).getTime()
  const diff = t - Date.now()
  const abs = absTime(iso)
  if (diff < 0) return `${abs} · atrasada`
  const min = Math.round(diff / 60000)
  if (min < 60) return `em ${min} min · ${abs}`
  const h = Math.round(min / 60)
  if (h < 24) return `em ${h}h · ${abs}`
  const days = Math.round(h / 24)
  return `em ${days} dia${days === 1 ? '' : 's'} · ${abs}`
}

export default function AgendamentosPage() {
  const { accountRole } = useAuth()
  const canManage = hasMinRole(accountRole ?? 'viewer', 'supervisor')

  const [counts, setCounts] = useState<SchedCounts>({
    pending: 0,
    sent: 0,
    cancelled: 0,
    failed: 0,
  })
  const [rows, setRows] = useState<ScheduledRow[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<SchedStatus | 'all'>('pending')
  const [search, setSearch] = useState('')
  const [assignedTo, setAssignedTo] = useState<string>('all')
  // Filtro de período (pedido do Rafael): hoje / ontem / últimos 7 dias.
  const [period, setPeriod] = useState<'all' | 'today' | 'yesterday' | '7d'>('all')
  const [members, setMembers] = useState<Member[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [list, c] = await Promise.all([
      listScheduled({
        status,
        search,
        assignedTo: assignedTo === 'all' ? undefined : assignedTo,
        period,
      }).catch(() => [] as ScheduledRow[]),
      getScheduledCounts().catch(() => ({
        pending: 0,
        sent: 0,
        cancelled: 0,
        failed: 0,
      })),
    ])
    setRows(list)
    setCounts(c)
    setLoading(false)
  }, [status, search, assignedTo, period])

  useEffect(() => {
    const t = setTimeout(() => void load(), 200)
    return () => clearTimeout(t)
  }, [load])

  useEffect(() => {
    if (!canManage) return
    listTeamMembers()
      .then((m) => setMembers(m as Member[]))
      .catch(() => setMembers([]))
  }, [canManage])

  // Recarrega ao voltar o foco/aba — assim uma mensagem recém-atribuída aparece
  // sem precisar dar reload manual.
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) void load()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [load])

  async function cancel(id: string) {
    if (!window.confirm('Cancelar este agendamento?')) return
    setBusyId(id)
    const { error } = await cancelScheduledMessage(id)
    setBusyId(null)
    if (error) {
      toast.error(error)
      return
    }
    toast.success('Agendamento cancelado')
    await load()
  }

  async function retry(id: string) {
    setBusyId(id)
    const { error } = await retryScheduled(id)
    setBusyId(null)
    if (error) {
      toast.error(error)
      return
    }
    toast.success('Reenviado — vai tentar de novo em ~1 min')
    await load()
  }

  async function reassign(id: string, newAssignee: string) {
    setBusyId(id)
    const { error } = await reassignScheduled(id, newAssignee)
    setBusyId(null)
    if (error) {
      toast.error(error)
      return
    }
    toast.success('Responsável atualizado')
    await load()
  }

  const countByKey = (k: SchedStatus | 'all') =>
    k === 'all'
      ? counts.pending + counts.sent + counts.cancelled + counts.failed
      : counts[k]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            Mensagens Agendadas
          </h1>
          <p className="text-sm text-muted-foreground">
            Tudo que está programado para enviar, o que já saiu e o que foi
            cancelado ou falhou.
          </p>
        </div>
        <ScheduleMessageDialog onScheduled={load} />
      </div>

      {/* Número fora do ar com agendadas presas nele — some sozinho quando
          não há nenhum. */}
      <BrokenChannelAlert onFixed={load} />

      {/* Painel de contadores (clicáveis → filtram por status). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {STATUS_TABS.map((t) => {
          const active = status === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setStatus(t.key)}
              className={`rounded-xl border p-4 text-left transition-colors ${
                active
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-card hover:bg-muted/40'
              }`}
            >
              <p className="text-xs text-muted-foreground">{t.label}</p>
              <p className="mt-1 text-2xl font-semibold text-foreground">
                {countByKey(t.key)}
              </p>
            </button>
          )
        })}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por contato ou texto…"
            className="pl-9"
          />
        </div>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as typeof period)}
          className="h-9 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground"
          title="Filtrar por período (fuso da conta)"
        >
          <option value="all">Todo o período</option>
          <option value="today">Hoje</option>
          <option value="yesterday">Ontem</option>
          <option value="7d">Últimos 7 dias</option>
        </select>
        {canManage && members.length > 0 && (
          <select
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
            className="h-9 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground"
          >
            <option value="all">Todos os responsáveis</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name ?? 'Sem nome'}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Lista */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-16 text-center">
          <CalendarClock className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            Nenhuma mensagem {status === 'all' ? '' : STATUS_TEXT[status as SchedStatus]?.toLowerCase()} aqui.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="flex items-start gap-3 p-3 sm:p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                  {(r.contact_name ?? r.contact_phone ?? '?')
                    .charAt(0)
                    .toUpperCase()}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate text-sm font-medium text-foreground">
                      {r.contact_name ?? r.contact_phone ?? 'Contato'}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_BADGE[r.status]}`}
                    >
                      {STATUS_TEXT[r.status]}
                    </span>
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {r.status === 'pending'
                        ? relTime(r.scheduled_at)
                        : absTime(r.scheduled_at)}
                    </span>
                  </div>

                  <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-foreground/80">
                    {r.content_text || '(sem texto)'}
                  </p>

                  {r.status === 'failed' && r.last_error && (
                    <p className="mt-1 flex items-start gap-1 text-[11px] text-red-500">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      {r.last_error}
                    </p>
                  )}

                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                    {r.created_by_name && <span>criada por {r.created_by_name}</span>}
                    {r.channel_name && (
                      <span>
                        · número {r.channel_name}
                        {r.channel_phone ? ` (${r.channel_phone})` : ''}
                      </span>
                    )}
                    {r.assigned_to_name && (
                      <span>· responsável {r.assigned_to_name}</span>
                    )}
                    {r.assigned_by && r.assigned_by !== r.created_by && r.assigned_by_name && (
                      <span>· atribuída por {r.assigned_by_name}</span>
                    )}
                  </div>

                  {/* Reatribuir (admin/supervisor, só nas pendentes). */}
                  {canManage && r.status === 'pending' && members.length > 0 && (
                    <div className="mt-1.5 flex items-center gap-1">
                      <UserCog className="h-3 w-3 text-muted-foreground" />
                      <select
                        value={r.assigned_to ?? ''}
                        disabled={busyId === r.id}
                        onChange={(e) => void reassign(r.id, e.target.value)}
                        className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground"
                      >
                        {!r.assigned_to && <option value="">—</option>}
                        {members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name ?? 'Sem nome'}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {/* Ações */}
                <div className="flex shrink-0 items-center gap-1">
                  <Link
                    href={`/inbox?c=${r.conversation_id}`}
                    title="Abrir conversa"
                    className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <MessageSquare className="h-4 w-4" />
                  </Link>
                  {r.status === 'failed' && (
                    <button
                      type="button"
                      onClick={() => void retry(r.id)}
                      disabled={busyId === r.id}
                      title="Reenviar"
                      className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                    >
                      {busyId === r.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RotateCw className="h-4 w-4" />
                      )}
                    </button>
                  )}
                  {r.status === 'pending' && (
                    <button
                      type="button"
                      onClick={() => void cancel(r.id)}
                      disabled={busyId === r.id}
                      title="Cancelar agendamento"
                      className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-red-600 disabled:opacity-50"
                    >
                      {busyId === r.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <X className="h-4 w-4" />
                      )}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
