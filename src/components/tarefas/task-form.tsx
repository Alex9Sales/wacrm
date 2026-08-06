'use client'

// ============================================================
// TaskForm — create / edit dialog for a Tarefa. pt-BR labels, dark
// theme, matches the app's UI kit. Fields: Título* · Descrição ·
// Prazo (datetime-local) · Status · Tipo (free text) · Cliente
// (searchable by name) · Card do Kanban (searchable by name).
//
// Cliente/Card use SearchablePicker so the user chooses BY NAME
// ("Opcional — escolha pelo nome") — never by typing an id.
// ============================================================

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
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
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Loader2 } from 'lucide-react'
import { SearchablePicker } from './searchable-picker'
import {
  createTask,
  updateTask,
  type TaskRow,
  type TaskStatus,
  type PickerOption,
} from '@/app/(dashboard)/tarefas/actions'
import { listProfiles } from '@/app/(dashboard)/inbox/actions'

interface TaskFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task?: TaskRow | null
  contacts: PickerOption[]
  deals: PickerOption[]
  onSaved: () => void
  /**
   * Prefill the Cliente picker when CREATING a new task (task is null) —
   * used by the inbox sidebar + Kanban card so the operator only fills
   * título/prazo. Ignored when editing (the task's own link wins).
   */
  prefillContactId?: string | null
  /** Prefill the Card do Kanban picker on create (see prefillContactId). */
  prefillDealId?: string | null
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  open: 'Aberta',
  done: 'Concluída',
  cancelled: 'Cancelada',
}

// Suggested type labels — free text, so the field is still editable.
const TYPE_SUGGESTIONS = ['ligar', 'cobrar', 'enviar_boleto', 'outro']

/** ISO / timestamptz string → value the <input type="datetime-local"> wants. */
function toLocalInput(value: string | null): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  // Local wall-clock, trimmed to minutes (YYYY-MM-DDTHH:mm).
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function TaskForm({
  open,
  onOpenChange,
  task,
  contacts,
  deals,
  onSaved,
  prefillContactId = null,
  prefillDealId = null,
}: TaskFormProps) {
  const isEdit = !!task

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [status, setStatus] = useState<TaskStatus>('open')
  const [type, setType] = useState('')
  const [contactId, setContactId] = useState<string | null>(null)
  const [dealId, setDealId] = useState<string | null>(null)
  const [assigneeIds, setAssigneeIds] = useState<string[]>([])
  const [members, setMembers] = useState<{ id: string; name: string }[]>([])
  const [memberFilter, setMemberFilter] = useState('')
  const [saving, setSaving] = useState(false)

  const toggleAssignee = (id: string) =>
    setAssigneeIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )

  // Só mostra o campo de busca quando a equipe é grande (senão é ruído para
  // 3-4 pessoas). Filtra por nome, sem mexer na seleção já feita.
  const SHOW_MEMBER_SEARCH_FROM = 7
  const filteredMembers = memberFilter.trim()
    ? members.filter((m) =>
        m.name.toLowerCase().includes(memberFilter.trim().toLowerCase()),
      )
    : members

  // Reset the form whenever the dialog opens (or the target task changes).
  useEffect(() => {
    if (!open) return
    setTitle(task?.title ?? '')
    setDescription(task?.description ?? '')
    setDueAt(toLocalInput(task?.due_at ?? null))
    setStatus(task?.status ?? 'open')
    setType(task?.type ?? '')
    // Editing → the task's own link wins. Creating → use the prefill so
    // the inbox sidebar / Kanban card can pre-select the client/card.
    setContactId(task?.contact_id ?? prefillContactId ?? null)
    setDealId(task?.deal_id ?? prefillDealId ?? null)
    setAssigneeIds(
      task?.assignee_ids?.length
        ? task.assignee_ids
        : task?.assigned_to
          ? [task.assigned_to]
          : [],
    )
    setMemberFilter('')
    // Load the team for the "Responsáveis" picker.
    listProfiles()
      .then((ps) =>
        setMembers(
          ps
            .filter((p) => p.user_id && p.full_name)
            .map((p) => ({ id: p.user_id as string, name: p.full_name as string })),
        ),
      )
      .catch(() => setMembers([]))
  }, [open, task, prefillContactId, prefillDealId])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) {
      toast.error('Informe o título da tarefa.')
      return
    }
    setSaving(true)
    try {
      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        // datetime-local has no timezone; send as-is so pg reads it in the
        // server tz. Empty → null (sem prazo).
        dueAt: dueAt || null,
        status,
        type: type.trim() || null,
        contactId,
        dealId,
        assigneeIds,
      }
      const res = isEdit
        ? await updateTask(task!.id, payload)
        : await createTask(payload)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(isEdit ? 'Tarefa atualizada.' : 'Tarefa criada.')
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar a tarefa.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover text-popover-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {isEdit ? 'Editar tarefa' : 'Nova tarefa'}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {isEdit
              ? 'Atualize os dados da tarefa.'
              : 'Crie uma tarefa ou lembrete para a sua equipe.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="task-title">
              Título <span className="text-destructive">*</span>
            </Label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ex.: Ligar para o cliente sobre o orçamento"
              autoFocus
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-description">Descrição</Label>
            <Textarea
              id="task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Detalhes da tarefa (opcional)"
              rows={3}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="task-due">Prazo</Label>
              <Input
                id="task-due"
                type="datetime-local"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Opcional — deixe em branco para tarefa sem prazo.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select
                value={status}
                onValueChange={(v) => v && setStatus(v as TaskStatus)}
              >
                <SelectTrigger className="w-full bg-background border-border text-foreground">
                  {/* Base UI <SelectValue> mostra o valor cru em re-render pesado;
                      renderiza o rótulo manualmente. */}
                  <SelectValue>{STATUS_LABELS[status]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">{STATUS_LABELS.open}</SelectItem>
                  <SelectItem value="done">{STATUS_LABELS.done}</SelectItem>
                  <SelectItem value="cancelled">{STATUS_LABELS.cancelled}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Responsáveis</Label>
            {members.length === 0 ? (
              <p className="text-xs text-muted-foreground">Carregando equipe…</p>
            ) : (
              <div className="space-y-1.5">
                {members.length >= SHOW_MEMBER_SEARCH_FROM && (
                  <Input
                    value={memberFilter}
                    onChange={(e) => setMemberFilter(e.target.value)}
                    // Enter na busca não deve enviar o formulário.
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.preventDefault()
                    }}
                    placeholder="Buscar membro pelo nome…"
                    className="h-8 text-sm"
                  />
                )}
                <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-md border border-border bg-background p-1">
                  {filteredMembers.length === 0 ? (
                    <p className="px-2 py-1.5 text-sm text-muted-foreground">
                      Ninguém encontrado.
                    </p>
                  ) : (
                    filteredMembers.map((m) => {
                      const checked = assigneeIds.includes(m.id)
                      return (
                        <label
                          key={m.id}
                          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground hover:bg-muted"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleAssignee(m.id)}
                            className="size-3.5 shrink-0 accent-primary"
                          />
                          <span className="truncate">{m.name}</span>
                        </label>
                      )
                    })
                  )}
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {assigneeIds.length === 0
                ? 'Marque um ou mais responsáveis. Cada um vê a tarefa no painel dele e é avisado. Também fica gravado quem criou.'
                : `${assigneeIds.length} ${assigneeIds.length === 1 ? 'responsável marcado' : 'responsáveis marcados'} — cada um vê a tarefa e é avisado.`}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-type">Tipo</Label>
            <Input
              id="task-type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder="Ex.: ligar, cobrar, enviar_boleto…"
              list="task-type-suggestions"
            />
            <datalist id="task-type-suggestions">
              {TYPE_SUGGESTIONS.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <p className="text-xs text-muted-foreground">
              Opcional — texto livre para categorizar a tarefa.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Cliente</Label>
            <SearchablePicker
              options={contacts}
              value={contactId}
              onChange={setContactId}
              placeholder="Selecionar cliente…"
              emptyLabel="Sem cliente"
            />
            <p className="text-xs text-muted-foreground">
              Opcional — escolha pelo nome.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Card do Kanban</Label>
            <SearchablePicker
              options={deals}
              value={dealId}
              onChange={setDealId}
              placeholder="Selecionar card…"
              emptyLabel="Sem card"
            />
            <p className="text-xs text-muted-foreground">
              Opcional — escolha pelo nome.
            </p>
          </div>

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
                  Salvando…
                </>
              ) : isEdit ? (
                'Salvar alterações'
              ) : (
                'Criar tarefa'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
