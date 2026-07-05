'use client'

// ============================================================
// SearchablePicker — a Popover + filter input that lets the user
// pick an option BY NAME (mirrors RecebIA's "escolha pelo nome").
// Used for the Cliente (contact) and Card do Kanban (deal) fields.
// Options are {id,label,sublabel}; selection returns the id (or null
// when cleared). Intentionally lightweight — no external combobox dep.
// ============================================================

import { useMemo, useState } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Check, ChevronsUpDown, Search, X } from 'lucide-react'
import type { PickerOption } from '@/app/(dashboard)/tarefas/actions'

interface SearchablePickerProps {
  options: PickerOption[]
  value: string | null
  onChange: (id: string | null) => void
  placeholder?: string
  /** Text for the "clear selection" row. */
  emptyLabel?: string
  disabled?: boolean
}

export function SearchablePicker({
  options,
  value,
  onChange,
  placeholder = 'Selecionar…',
  emptyLabel = 'Nenhum',
  disabled = false,
}: SearchablePickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const selected = useMemo(
    () => options.find((o) => o.id === value) ?? null,
    [options, value],
  )

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return options
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(term) ||
        (o.sublabel ?? '').toLowerCase().includes(term),
    )
  }, [options, query])

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        className={cn(
          'flex h-9 w-full items-center gap-2 rounded-md border border-border bg-background px-3 text-sm',
          'text-left transition-colors hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <span
          className={cn(
            'flex-1 truncate',
            selected ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {selected ? selected.label : placeholder}
        </span>
        {selected ? (
          <span
            role="button"
            tabIndex={0}
            aria-label="Limpar seleção"
            onClick={(e) => {
              e.stopPropagation()
              onChange(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onChange(null)
              }
            }}
            className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 border-border bg-popover p-0 text-popover-foreground"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar pelo nome…"
            className="h-7 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          <button
            type="button"
            onClick={() => {
              onChange(null)
              setOpen(false)
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
          >
            <span className="w-4" />
            {emptyLabel}
          </button>
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              Nada encontrado.
            </p>
          ) : (
            filtered.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  onChange(o.id)
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                <span className="w-4 shrink-0">
                  {o.id === value ? <Check className="h-4 w-4 text-primary" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-foreground">{o.label}</span>
                  {o.sublabel ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {o.sublabel}
                    </span>
                  ) : null}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
