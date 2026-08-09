'use client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import {
  listCompanyOptions,
  findOrCreateCompanyByName,
  type CompanyLite,
} from '@/app/(dashboard)/empresas/actions'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Building2, ChevronsUpDown, Plus, X, Check, Loader2 } from 'lucide-react'

/**
 * Seletor de empresa (combobox): busca as existentes ou cria uma nova pelo
 * nome. `value`/`valueName` = empresa atual do negócio. onChange devolve o id
 * (ou null p/ desvincular) + o nome, e o pai persiste (setDealCompany).
 */
export function CompanyPicker({
  value,
  valueName,
  onChange,
}: {
  value: string | null
  valueName: string | null
  onChange: (companyId: string | null, name: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<CompanyLite[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setQ('')
    listCompanyOptions()
      .then(setOptions)
      .catch(() => setOptions([]))
  }, [open])

  const term = q.trim().toLowerCase()
  const filtered = term
    ? options.filter((o) => o.name.toLowerCase().includes(term))
    : options
  const exact = options.some((o) => o.name.toLowerCase() === term)
  const canCreate = term.length > 0 && !exact

  function pick(id: string | null, name: string | null) {
    onChange(id, name)
    setOpen(false)
  }

  async function createNew() {
    setBusy(true)
    const res = await findOrCreateCompanyByName(q.trim())
    setBusy(false)
    if (!res.ok) {
      toast.error(res.error)
      return
    }
    pick(res.company.id, res.company.name)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex w-full items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted">
        <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className={valueName ? 'flex-1 truncate' : 'flex-1 truncate text-muted-foreground'}>
          {valueName || 'Selecionar empresa'}
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="border-b border-border p-2">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar ou criar…"
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
          />
        </div>
        <div className="max-h-52 overflow-y-auto p-1">
          {value && (
            <button
              type="button"
              onClick={() => pick(null, null)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted"
            >
              <X className="h-3.5 w-3.5" /> Remover empresa
            </button>
          )}
          {filtered.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => pick(o.id, o.name)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted"
            >
              <Check
                className={`h-3.5 w-3.5 shrink-0 ${o.id === value ? 'text-primary' : 'text-transparent'}`}
              />
              <span className="truncate">{o.name}</span>
            </button>
          ))}
          {filtered.length === 0 && !canCreate && (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              Nenhuma empresa.
            </p>
          )}
          {canCreate && (
            <button
              type="button"
              onClick={() => void createNew()}
              disabled={busy}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Criar “{q.trim()}”
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
