'use client'

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  listDealContacts,
  addDealContact,
  removeDealContact,
  type DealContactRow,
} from '@/app/(dashboard)/pipelines/actions'
import {
  listContactsForPicker,
  type PickerOption,
} from '@/app/(dashboard)/tarefas/actions'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Users, Plus, X, Loader2 } from 'lucide-react'

/**
 * Contatos do negócio (Empresas Fase 2): o PRINCIPAL (deals.contact_id, com
 * badge) + os ADICIONAIS (deal_contacts), com adicionar/remover. Vários
 * contatos por negócio, estilo RD.
 */
export function DealContactsPanel({ dealId }: { dealId: string }) {
  const [rows, setRows] = useState<DealContactRow[]>([])
  const [options, setOptions] = useState<PickerOption[]>([])
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setRows(await listDealContacts(dealId).catch(() => []))
  }, [dealId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!open) return
    setQ('')
    listContactsForPicker()
      .then(setOptions)
      .catch(() => setOptions([]))
  }, [open])

  async function add(contactId: string) {
    setBusyId(contactId)
    const { error } = await addDealContact(dealId, contactId)
    setBusyId(null)
    if (error) {
      toast.error(error)
      return
    }
    setOpen(false)
    await load()
  }

  async function remove(contactId: string) {
    setBusyId(contactId)
    const { error } = await removeDealContact(dealId, contactId)
    setBusyId(null)
    if (error) {
      toast.error(error)
      return
    }
    setRows((prev) => prev.filter((r) => r.id !== contactId))
  }

  const currentIds = new Set(rows.map((r) => r.id))
  const term = q.trim().toLowerCase()
  const available = options
    .filter((o) => !currentIds.has(o.id))
    .filter(
      (o) =>
        !term ||
        o.label.toLowerCase().includes(term) ||
        (o.sublabel ?? '').toLowerCase().includes(term),
    )

  return (
    <div className="mt-4 space-y-2 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Users className="h-3.5 w-3.5" /> Contatos
        </p>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted">
            <Plus className="h-3 w-3" /> Adicionar
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 p-0">
            <div className="border-b border-border p-2">
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Buscar contato…"
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
              />
            </div>
            <div className="max-h-52 overflow-y-auto p-1">
              {available.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  Nenhum contato.
                </p>
              ) : (
                available.slice(0, 50).map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => void add(o.id)}
                    disabled={busyId === o.id}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted disabled:opacity-50"
                  >
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                      {(o.label || '?').charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-foreground">{o.label}</p>
                      {o.sublabel && (
                        <p className="truncate text-[10px] text-muted-foreground">
                          {o.sublabel}
                        </p>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">Sem contatos.</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((c) => (
            <li key={c.id} className="flex items-center gap-2">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                {(c.name ?? c.phone).charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-foreground">
                  {c.name ?? c.phone}
                  {c.is_primary && (
                    <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                      Principal
                    </span>
                  )}
                </p>
                <p className="truncate text-[10px] text-muted-foreground">
                  {c.phone}
                </p>
              </div>
              {!c.is_primary && (
                <button
                  type="button"
                  onClick={() => void remove(c.id)}
                  disabled={busyId === c.id}
                  title="Remover do negócio"
                  className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-red-600 disabled:opacity-50"
                >
                  {busyId === c.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <X className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
