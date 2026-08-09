'use client'

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import {
  listProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  type ProductRow,
  type ProductKind,
} from '@/app/(dashboard)/settings/products-actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Package,
  Wrench,
  Plus,
  Pencil,
  Trash2,
  Loader2,
} from 'lucide-react'

function brl(n: number) {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

type EditValue = {
  id?: string
  name: string
  description: string
  kind: ProductKind
  unitPrice: string
  active: boolean
}

const EMPTY: EditValue = {
  name: '',
  description: '',
  kind: 'product',
  unitPrice: '',
  active: true,
}

export function ProductsPanel() {
  const [items, setItems] = useState<ProductRow[]>([])
  const [loading, setLoading] = useState(true)
  const [includeInactive, setIncludeInactive] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [draft, setDraft] = useState<EditValue>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setItems(await listProducts({ includeInactive }).catch(() => []))
    setLoading(false)
  }, [includeInactive])

  useEffect(() => {
    void load()
  }, [load])

  function openNew() {
    setDraft(EMPTY)
    setFormOpen(true)
  }
  function openEdit(p: ProductRow) {
    setDraft({
      id: p.id,
      name: p.name,
      description: p.description ?? '',
      kind: p.kind,
      unitPrice: p.unit_price ? String(p.unit_price) : '',
      active: p.active,
    })
    setFormOpen(true)
  }

  async function save() {
    if (!draft.name.trim()) {
      toast.error('O nome é obrigatório.')
      return
    }
    setSaving(true)
    const priceNum = Number(draft.unitPrice.replace(',', '.')) || 0
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      kind: draft.kind,
      unitPrice: priceNum,
      active: draft.active,
    }
    if (draft.id) {
      const res = await updateProduct(draft.id, payload)
      setSaving(false)
      if (res.error) {
        toast.error(res.error)
        return
      }
      toast.success('Item atualizado')
    } else {
      const res = await createProduct(payload)
      setSaving(false)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success('Item criado')
    }
    setFormOpen(false)
    await load()
  }

  async function remove(p: ProductRow) {
    if (!window.confirm(`Excluir "${p.name}" do catálogo?`)) return
    setBusyId(p.id)
    const { error } = await deleteProduct(p.id)
    setBusyId(null)
    if (error) {
      toast.error(error)
      return
    }
    toast.success('Excluído')
    await load()
  }

  async function toggleActive(p: ProductRow) {
    setBusyId(p.id)
    const { error } = await updateProduct(p.id, { active: !p.active })
    setBusyId(null)
    if (error) {
      toast.error(error)
      return
    }
    await load()
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            Produtos e serviços
          </h2>
          <p className="text-sm text-muted-foreground">
            Cadastre seu catálogo para reaproveitar nos produtos do negócio.
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus className="mr-1.5 h-4 w-4" /> Novo
        </Button>
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={includeInactive}
          onChange={(e) => setIncludeInactive(e.target.checked)}
        />
        Mostrar inativos
      </label>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-16 text-center">
          <Package className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">
            Catálogo vazio.
          </p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            Cadastre produtos e serviços com preço para adicioná-los rápido aos
            negócios.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <ul className="divide-y divide-border">
            {items.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-3 bg-card px-4 py-3"
              >
                <div
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                    p.kind === 'service'
                      ? 'bg-violet-500/10 text-violet-500'
                      : 'bg-primary/10 text-primary'
                  }`}
                >
                  {p.kind === 'service' ? (
                    <Wrench className="h-4 w-4" />
                  ) : (
                    <Package className="h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate text-sm font-medium ${
                      p.active ? 'text-foreground' : 'text-muted-foreground line-through'
                    }`}
                  >
                    {p.name}
                    <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                      {p.kind === 'service' ? 'Serviço' : 'Produto'}
                    </span>
                  </p>
                  {p.description && (
                    <p className="truncate text-xs text-muted-foreground">
                      {p.description}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-sm font-medium text-foreground">
                  {brl(p.unit_price)}
                </span>
                <button
                  type="button"
                  onClick={() => void toggleActive(p)}
                  disabled={busyId === p.id}
                  title={p.active ? 'Desativar' : 'Ativar'}
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    p.active
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {p.active ? 'Ativo' : 'Inativo'}
                </button>
                <button
                  type="button"
                  onClick={() => openEdit(p)}
                  title="Editar"
                  className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => void remove(p)}
                  disabled={busyId === p.id}
                  title="Excluir"
                  className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-red-600 disabled:opacity-50"
                >
                  {busyId === p.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {draft.id ? 'Editar item' : 'Novo produto ou serviço'}
            </DialogTitle>
            <DialogDescription>
              Nome e preço aparecem ao adicionar aos produtos do negócio.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label htmlFor="prod-name">Nome *</Label>
              <Input
                id="prod-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Ex.: Plano Mensal"
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="prod-kind">Tipo</Label>
                <select
                  id="prod-kind"
                  value={draft.kind}
                  onChange={(e) =>
                    setDraft({ ...draft, kind: e.target.value as ProductKind })
                  }
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
                >
                  <option value="product">Produto</option>
                  <option value="service">Serviço</option>
                </select>
              </div>
              <div>
                <Label htmlFor="prod-price">Preço (R$)</Label>
                <Input
                  id="prod-price"
                  inputMode="decimal"
                  value={draft.unitPrice}
                  onChange={(e) =>
                    setDraft({ ...draft, unitPrice: e.target.value })
                  }
                  placeholder="0,00"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="prod-desc">Descrição</Label>
              <Textarea
                id="prod-desc"
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
                rows={2}
                placeholder="Detalhes (opcional)"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={draft.active}
                onChange={(e) =>
                  setDraft({ ...draft, active: e.target.checked })
                }
              />
              Ativo (aparece na hora de adicionar ao negócio)
            </label>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setFormOpen(false)}
              disabled={saving}
            >
              Cancelar
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {draft.id ? 'Salvar' : 'Criar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
