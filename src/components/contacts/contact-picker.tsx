'use client'

// ============================================================
// ContactPicker — seletor UNIVERSAL de contato: digita e acha por nome,
// telefone, e-mail ou código do cliente; e cria contato na hora sem sair do
// formulário ("➕ Criar contato"). Substitui os <select> crus de contato
// (que listavam a base inteira, com IGSIDs e tudo). Erro de carga mostra
// aviso de recarregar — nunca finge lista vazia (lição do chamado do Rafael).
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Plus, Search, X } from 'lucide-react'

import {
  searchPickerContacts,
  getPickerContact,
  createPickerContact,
  type PickerContact,
} from './contact-picker-actions'

function labelOf(c: PickerContact): string {
  return c.name || c.phone || c.email || c.id.slice(0, 8)
}

export function ContactPicker({
  value,
  onChange,
  placeholder = 'Buscar por nome, telefone ou código...',
  disabled,
}: {
  /** id do contato selecionado ('' = nenhum). */
  value: string
  /** Chamado ao selecionar/limpar. `contact` vem junto pra quem precisa. */
  onChange: (contactId: string, contact: PickerContact | null) => void
  placeholder?: string
  disabled?: boolean
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PickerContact[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [selected, setSelected] = useState<PickerContact | null>(null)
  // "➕ Criar contato" inline.
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [createError, setCreateError] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  // Valor inicial já salvo → busca o rótulo.
  useEffect(() => {
    if (!value) {
      setSelected(null)
      return
    }
    if (selected?.id === value) return
    let alive = true
    getPickerContact(value)
      .then((c) => alive && c && setSelected(c))
      .catch(() => {})
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  // Fecha no clique fora.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Busca com debounce.
  const search = useCallback(async (q: string) => {
    setLoading(true)
    setLoadError(false)
    try {
      const res = await searchPickerContacts(q)
      if (res === null) setLoadError(true)
      else setResults(res)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => void search(query), 250)
    return () => clearTimeout(t)
  }, [query, open, search])

  async function handleCreate() {
    setCreateError('')
    setBusy(true)
    const { contact, error } = await createPickerContact({
      name: newName,
      phone: newPhone,
    })
    setBusy(false)
    if (error || !contact) {
      setCreateError(error ?? 'Falha ao criar.')
      return
    }
    setSelected(contact)
    onChange(contact.id, contact)
    setOpen(false)
    setCreating(false)
    setNewName('')
    setNewPhone('')
  }

  const inputCls =
    'h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary'

  // Selecionado → chip com trocar/limpar.
  if (value && selected && !open) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted px-2.5 py-2 text-sm text-foreground">
        <span className="truncate">
          {labelOf(selected)}
          {selected.phone && selected.name ? (
            <span className="text-muted-foreground"> · {selected.phone}</span>
          ) : null}
        </span>
        {!disabled ? (
          <span className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setOpen(true)
                setQuery('')
              }}
              className="text-xs text-primary underline-offset-2 hover:underline"
            >
              Trocar
            </button>
            <button
              type="button"
              onClick={() => {
                setSelected(null)
                onChange('', null)
              }}
              title="Limpar"
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          disabled={disabled}
          className={`${inputCls} pl-8`}
        />
      </div>

      {open ? (
        <div className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
          {creating ? (
            <div className="space-y-2 p-2">
              <p className="text-xs font-semibold text-foreground">
                ➕ Novo contato
              </p>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Nome"
                className={inputCls}
                autoFocus
              />
              <input
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="WhatsApp com DDD — (67) 99999-9999"
                className={inputCls}
              />
              {createError ? (
                <p className="text-xs text-rose-500">{createError}</p>
              ) : null}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={busy}
                  className="flex-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? (
                    <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin" />
                  ) : (
                    'Criar e selecionar'
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                >
                  Voltar
                </button>
              </div>
            </div>
          ) : (
            <>
              {loading ? (
                <div className="flex justify-center py-3">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : loadError ? (
                <p className="px-2 py-2 text-xs text-amber-600 dark:text-amber-400">
                  ⚠️ Não consegui buscar — recarregue a página (Ctrl+Shift+R).
                </p>
              ) : results.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">
                  Nenhum contato encontrado.
                </p>
              ) : (
                results.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setSelected(c)
                      onChange(c.id, c)
                      setOpen(false)
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {labelOf(c)}
                      {c.phone && c.name ? (
                        <span className="text-xs text-muted-foreground">
                          {' '}
                          · {c.phone}
                        </span>
                      ) : null}
                    </span>
                    {c.code ? (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        #{c.code}
                      </span>
                    ) : null}
                  </button>
                ))
              )}
              <button
                type="button"
                onClick={() => {
                  setCreating(true)
                  setCreateError('')
                  // Pré-preenche com o que a pessoa digitou.
                  const digits = query.replace(/\D/g, '')
                  if (digits.length >= 10) setNewPhone(query.trim())
                  else if (query.trim()) setNewName(query.trim())
                }}
                className="mt-1 flex w-full items-center gap-1.5 rounded-md border-t border-border px-2 py-2 text-left text-sm font-medium text-primary hover:bg-muted"
              >
                <Plus className="h-3.5 w-3.5" /> Criar contato
                {query.trim() ? ` "${query.trim()}"` : ''}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
