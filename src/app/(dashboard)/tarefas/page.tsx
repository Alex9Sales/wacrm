'use client'

// ============================================================
// Tarefas (Tasks) page. A RecebIA-style table: CLIENTE · TÍTULO ·
// TIPO · PRAZO (overdue rows highlighted RED, "vence hoje" marked) ·
// STATUS · AÇÕES. Top bar: busca + filtro de status + "+ Novo".
// Everything is account-scoped through the server actions. Reads are
// open to any member; create/edit/delete/toggle require agent+
// (enforced server-side; the UI gates the buttons too).
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  listTasks,
  toggleTaskDone,
  deleteTask,
  listContactsForPicker,
  listDealsForPicker,
  type TaskRow,
  type PickerOption,
} from './actions'
import { TaskForm } from '@/components/tarefas/task-form'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import {
  Search,
  Plus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
  ListTodo,
} from 'lucide-react'
import { useCan } from '@/hooks/use-can'
import { cn } from '@/lib/utils'

type StatusFilter = 'todas' | 'open' | 'done' | 'overdue'

const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  todas: 'Todas',
  open: 'Abertas',
  done: 'Concluídas',
  overdue: 'Vencidas',
}

const STATUS_META: Record<
  TaskRow['status'],
  { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }
> = {
  open: { label: 'Aberta', variant: 'outline' },
  done: { label: 'Concluída', variant: 'secondary' },
  cancelled: { label: 'Cancelada', variant: 'destructive' },
}

const dateFmt = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

function isSameLocalDay(iso: string): boolean {
  const d = new Date(iso)
  const now = new Date()
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  )
}

export default function TarefasPage() {
  const canManage = useCan('send-messages') // agent+ can manage tasks

  const [rows, setRows] = useState<TaskRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('todas')

  const [contacts, setContacts] = useState<PickerOption[]>([])
  const [deals, setDeals] = useState<PickerOption[]>([])

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<TaskRow | null>(null)

  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listTasks({
        status: statusFilter === 'todas' ? undefined : statusFilter,
        search: search.trim() || undefined,
      })
      setRows(data)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao carregar tarefas.')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, search])

  // Load pickers once (contacts + deals for the create/edit form).
  useEffect(() => {
    let alive = true
    Promise.all([listContactsForPicker(), listDealsForPicker()])
      .then(([c, d]) => {
        if (!alive) return
        setContacts(c)
        setDeals(d)
      })
      .catch(() => {
        /* pickers are best-effort; form still works without them */
      })
    return () => {
      alive = false
    }
  }, [])

  // Debounced refetch on filter/search change.
  useEffect(() => {
    const t = setTimeout(() => void refetch(), 200)
    return () => clearTimeout(t)
  }, [refetch])

  const overdueCount = useMemo(() => rows.filter((r) => r.overdue).length, [rows])

  async function handleToggle(row: TaskRow) {
    if (!canManage) return
    const res = await toggleTaskDone(row.id)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    await refetch()
  }

  async function handleDelete(row: TaskRow) {
    if (!canManage) return
    if (!confirm(`Excluir a tarefa "${row.title}"?`)) return
    const res = await deleteTask(row.id)
    if (res.error) {
      toast.error(res.error)
      return
    }
    toast.success('Tarefa excluída.')
    await refetch()
  }

  function openCreate() {
    setEditing(null)
    setFormOpen(true)
  }

  function openEdit(row: TaskRow) {
    setEditing(row)
    setFormOpen(true)
  }

  return (
    <div className="flex h-full flex-col gap-4 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <ListTodo className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold text-foreground">Tarefas</h1>
          {overdueCount > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[10px] font-semibold text-destructive-foreground">
              {overdueCount} vencida{overdueCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Tarefas e lembretes da sua conta. Prazos vencidos aparecem em vermelho.
        </p>
      </div>

      {/* Top bar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por título, cliente, tipo…"
            className="pl-9"
          />
        </div>

        <Select
          value={statusFilter}
          onValueChange={(v) => v && setStatusFilter(v as StatusFilter)}
        >
          <SelectTrigger className="w-full border-border bg-background text-foreground sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(STATUS_FILTER_LABELS) as StatusFilter[]).map((k) => (
              <SelectItem key={k} value={k}>
                {STATUS_FILTER_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {canManage && (
          <Button onClick={openCreate} className="shrink-0">
            <Plus className="h-4 w-4" />
            Novo
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {canManage && <TableHead className="w-10" />}
              <TableHead>Cliente</TableHead>
              <TableHead>Título</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Prazo</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="w-14 text-right">Ações</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={canManage ? 7 : 5} className="h-32 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={canManage ? 7 : 5}
                  className="h-32 text-center text-sm text-muted-foreground"
                >
                  Nenhuma tarefa encontrada.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const dueToday =
                  row.due_at != null && row.status === 'open' && isSameLocalDay(row.due_at)
                const statusMeta = STATUS_META[row.status]
                return (
                  <TableRow
                    key={row.id}
                    className={cn(row.overdue && 'bg-destructive/5 hover:bg-destructive/10')}
                  >
                    {canManage && (
                      <TableCell>
                        <Checkbox
                          checked={row.status === 'done'}
                          onCheckedChange={() => void handleToggle(row)}
                          aria-label="Concluir tarefa"
                        />
                      </TableCell>
                    )}
                    <TableCell className="max-w-[12rem] truncate">
                      {row.contact_name ? (
                        <span className="text-foreground">{row.contact_name}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[18rem]">
                      <span
                        className={cn(
                          'block truncate font-medium text-foreground',
                          row.status === 'done' && 'text-muted-foreground line-through',
                        )}
                        title={row.title}
                      >
                        {row.title}
                      </span>
                      {row.deal_title &&
                        (row.deal_id ? (
                          // Dica do Rafael: dá pra VER e ABRIR o card a que a
                          // tarefa está presa, sem caçar no funil.
                          <a
                            href={`/pipelines/${row.deal_id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="block truncate text-xs text-primary hover:underline"
                            title={`Abrir card: ${row.deal_title}`}
                          >
                            Card: {row.deal_title}
                          </a>
                        ) : (
                          <span className="block truncate text-xs text-muted-foreground">
                            Card: {row.deal_title}
                          </span>
                        ))}
                      {/* Quem é dono da tarefa: atribuída a X (, Y, …) · criada por Z */}
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                        {row.assignee_names.length > 0
                          ? `Atribuída a ${row.assignee_names.join(', ')}`
                          : 'Não atribuída'}
                        {row.created_by_name && ` · criada por ${row.created_by_name}`}
                      </span>
                    </TableCell>
                    <TableCell>
                      {row.type ? (
                        <Badge variant="outline">{row.type}</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.due_at ? (
                        <span
                          className={cn(
                            'text-sm',
                            row.overdue
                              ? 'font-medium text-destructive'
                              : dueToday
                                ? 'font-medium text-amber-500'
                                : 'text-foreground',
                          )}
                        >
                          {dateFmt.format(new Date(row.due_at))}
                          {row.overdue && (
                            <span className="ml-1 text-xs font-semibold">(vencida)</span>
                          )}
                          {!row.overdue && dueToday && (
                            <span className="ml-1 text-xs font-semibold">(vence hoje)</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button variant="ghost" size="icon-sm" aria-label="Ações" />
                            }
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEdit(row)}>
                              <Pencil className="h-4 w-4" />
                              Editar
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => void handleDelete(row)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="h-4 w-4" />
                              Excluir
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    )}
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <TaskForm
        open={formOpen}
        onOpenChange={setFormOpen}
        task={editing}
        contacts={contacts}
        deals={deals}
        onSaved={refetch}
      />
    </div>
  )
}
