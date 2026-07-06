'use client'

// ============================================================
// ScheduleMiniList — compact list of a conversation's scheduled messages
// (inbox sidebar "Mensagens agendadas" section). Each row shows the text
// preview, when it fires, and status. Pending rows can be cancelled;
// settled ones (sent/cancelled/failed) are shown muted for a short trail.
// pt-BR, dark theme. Does NOT own the create dialog — the caller wires the
// ScheduleMessageForm and passes onChanged to refetch.
// ============================================================

import { useState } from 'react'
import { toast } from 'sonner'
import { CalendarClock, Trash2, Loader2, Check, X, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  cancelScheduledMessage,
  type ScheduledMessageLite,
  type ScheduledMessageStatus,
} from '@/app/(dashboard)/inbox/schedule-actions'

/** Format the fire time as dd/MM · HH:mm. */
function formatWhen(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const STATUS_META: Record<
  ScheduledMessageStatus,
  { label: string; className: string; Icon: typeof Check | null }
> = {
  pending: { label: 'Agendada', className: 'text-primary', Icon: CalendarClock },
  sent: { label: 'Enviada', className: 'text-emerald-400', Icon: Check },
  cancelled: { label: 'Cancelada', className: 'text-muted-foreground', Icon: X },
  failed: { label: 'Falhou', className: 'text-red-400', Icon: AlertTriangle },
}

interface ScheduleMiniListProps {
  items: ScheduledMessageLite[]
  onChanged: () => void
  emptyLabel?: string
}

export function ScheduleMiniList({
  items,
  onChanged,
  emptyLabel = 'Nenhuma mensagem agendada.',
}: ScheduleMiniListProps) {
  const [busyId, setBusyId] = useState<string | null>(null)

  async function handleCancel(id: string) {
    setBusyId(id)
    try {
      const { error } = await cancelScheduledMessage(id)
      if (error) {
        toast.error(error)
        return
      }
      onChanged()
    } finally {
      setBusyId(null)
    }
  }

  if (items.length === 0) {
    return <p className="px-1 text-xs text-muted-foreground">{emptyLabel}</p>
  }

  return (
    <div className="space-y-1.5">
      {items.map((item) => {
        const meta = STATUS_META[item.status]
        const Icon = meta.Icon
        const busy = busyId === item.id
        const settled = item.status !== 'pending'
        return (
          <div
            key={item.id}
            className="group flex items-start gap-2 rounded-lg bg-muted px-2.5 py-2"
          >
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'line-clamp-2 text-xs leading-snug text-foreground',
                  settled && 'text-muted-foreground',
                )}
              >
                {item.content_text || '[mensagem]'}
              </p>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                <span className={cn('flex items-center gap-1', meta.className)}>
                  {Icon && <Icon className="h-2.5 w-2.5" />}
                  {meta.label} · {formatWhen(item.scheduled_at)}
                </span>
              </div>
              {item.status === 'failed' && item.last_error && (
                <p className="mt-0.5 line-clamp-1 text-[10px] text-red-400/80">
                  {item.last_error}
                </p>
              )}
            </div>

            {item.status === 'pending' && (
              <button
                type="button"
                onClick={() => void handleCancel(item.id)}
                disabled={busy}
                aria-label="Cancelar agendamento"
                title="Cancelar"
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
              >
                {busy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
