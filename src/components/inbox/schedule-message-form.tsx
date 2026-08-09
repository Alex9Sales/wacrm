'use client'

// ============================================================
// ScheduleMessageForm — schedule a single text message into the current
// conversation. Fields: Mensagem* (textarea) · Enviar em* (datetime-local
// with quick presets). The datetime-local is local wall-clock; we convert
// it to an absolute ISO instant (new Date(local).toISOString()) before
// calling the server so the worker fires at the right moment regardless of
// server timezone.
// ============================================================

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  scheduleMessage,
  updateScheduledMessage,
  type ScheduledMessageLite,
} from '@/app/(dashboard)/inbox/schedule-actions'
import { listTeamMembers } from '@/app/(dashboard)/internal-chat/actions'
import { useAuth } from '@/hooks/use-auth'
import { hasMinRole } from '@/lib/auth/roles'

interface ScheduleMessageFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversationId: string
  onSaved: () => void
  /** Quando setado, o form edita este agendamento (pendente) em vez de criar. */
  editing?: ScheduledMessageLite | null
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A Date → the value a <input type="datetime-local"> expects (local, mins). */
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Presets relative to now, returned as datetime-local strings. */
function presets(): { label: string; value: string }[] {
  const now = new Date()
  const inHour = new Date(now.getTime() + 60 * 60 * 1000)
  const in3h = new Date(now.getTime() + 3 * 60 * 60 * 1000)
  const tomorrow9 = new Date(now)
  tomorrow9.setDate(tomorrow9.getDate() + 1)
  tomorrow9.setHours(9, 0, 0, 0)
  const nextWeek9 = new Date(now)
  nextWeek9.setDate(nextWeek9.getDate() + 7)
  nextWeek9.setHours(9, 0, 0, 0)
  return [
    { label: 'Em 1 hora', value: toLocalInput(inHour) },
    { label: 'Em 3 horas', value: toLocalInput(in3h) },
    { label: 'Amanhã 9h', value: toLocalInput(tomorrow9) },
    { label: 'Próx. semana', value: toLocalInput(nextWeek9) },
  ]
}

export function ScheduleMessageForm({
  open,
  onOpenChange,
  conversationId,
  onSaved,
  editing,
}: ScheduleMessageFormProps) {
  const { accountRole } = useAuth()
  // Só admin/supervisor escolhem o responsável (agente agenda pro próprio lead).
  const canAssign = hasMinRole(accountRole ?? 'viewer', 'supervisor')

  const [text, setText] = useState('')
  const [when, setWhen] = useState('')
  const [assignee, setAssignee] = useState('') // '' = herda o dono do lead
  const [members, setMembers] = useState<{ id: string; name: string | null }[]>(
    [],
  )
  const [saving, setSaving] = useState(false)

  // Ao abrir: se estiver editando, prefill com o agendamento; senão, novo
  // (padrão daqui a 1 hora).
  useEffect(() => {
    if (!open) return
    if (editing) {
      setText(editing.content_text ?? '')
      setWhen(toLocalInput(new Date(editing.scheduled_at)))
    } else {
      setText('')
      setWhen(toLocalInput(new Date(Date.now() + 60 * 60 * 1000)))
      setAssignee('')
    }
  }, [open, editing])

  // Carrega os membros p/ o seletor de responsável (só admin/supervisor).
  useEffect(() => {
    if (!open || !canAssign) return
    listTeamMembers()
      .then((m) => setMembers(m as { id: string; name: string | null }[]))
      .catch(() => setMembers([]))
  }, [open, canAssign])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const body = text.trim()
    if (!body) {
      toast.error('Escreva a mensagem.')
      return
    }
    if (!when) {
      toast.error('Escolha data e hora.')
      return
    }
    const local = new Date(when)
    if (Number.isNaN(local.getTime())) {
      toast.error('Data/hora inválida.')
      return
    }
    if (local.getTime() - Date.now() < 60_000) {
      toast.error('Escolha um horário pelo menos 1 min à frente.')
      return
    }

    setSaving(true)
    try {
      const res = editing
        ? await updateScheduledMessage(editing.id, {
            contentText: body,
            scheduledAt: local.toISOString(),
          })
        : await scheduleMessage({
            conversationId,
            contentText: body,
            // Absolute instant — local wall-clock converted to UTC ISO.
            scheduledAt: local.toISOString(),
            // '' = herda o dono do lead; admin/supervisor podem atribuir.
            assignedTo: assignee || null,
          })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(editing ? 'Agendamento atualizado.' : 'Mensagem agendada.')
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao agendar.')
    } finally {
      setSaving(false)
    }
  }

  const nowLocal = toLocalInput(new Date())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover text-popover-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {editing ? 'Editar mensagem agendada' : 'Agendar mensagem'}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            A mensagem será enviada automaticamente nesta conversa no horário
            escolhido.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sched-text">
              Mensagem <span className="text-destructive">*</span>
            </Label>
            <textarea
              id="sched-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Escreva a mensagem que será enviada…"
              rows={4}
              autoFocus
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sched-when">
              Enviar em <span className="text-destructive">*</span>
            </Label>
            <Input
              id="sched-when"
              type="datetime-local"
              value={when}
              min={nowLocal}
              onChange={(e) => setWhen(e.target.value)}
              required
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {presets().map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setWhen(p.value)}
                  className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Responsável — só admin/supervisor, só ao criar. Vazio = dono do lead. */}
          {canAssign && !editing && members.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="sched-assignee">Responsável</Label>
              <select
                id="sched-assignee"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
              >
                <option value="">Dono do lead (padrão)</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name ?? 'Sem nome'}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">
                Quem fica responsável por esta mensagem. Se for outra pessoa, ela
                é notificada e a mensagem aparece na central dela.
              </p>
            </div>
          )}

          <DialogFooter className="border-border bg-popover">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {editing ? 'Salvando…' : 'Agendando…'}
                </>
              ) : editing ? (
                'Salvar'
              ) : (
                'Agendar'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
