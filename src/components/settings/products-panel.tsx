'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import {
  listProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  importProducts,
  type ProductRow,
  type ProductKind,
} from '@/app/(dashboard)/settings/products-actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MoneyInput } from '@/components/ui/money-input'
import { formatBrlInput, parseBrlField } from '@/lib/format/parse-brl'
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
import { parseSheet, downloadCsv } from '@/lib/import/sheet'
import { mapProductRows } from '@/lib/import/products-sheet'
import { formatMoneyError } from '@/lib/import/money'
import {
  Package,
  Wrench,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Upload,
  Download,
} from 'lucide-react'

function brl(n: number) {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

/** Quantas linhas com preço inválido o aviso da importação lista por extenso. */
const MAX_PRICE_ERRORS = 8

type EditValue = {
  id?: string
  name: string
  description: string
  kind: ProductKind
  unitPrice: string
  linkUrl: string
  imageUrl: string
  active: boolean
}

const EMPTY: EditValue = {
  name: '',
  description: '',
  kind: 'product',
  unitPrice: '',
  linkUrl: '',
  imageUrl: '',
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
  const [importing, setImporting] = useState(false)
  const [uploadingImg, setUploadingImg] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const imgRef = useRef<HTMLInputElement>(null)

  // Sobe a foto do produto pro MinIO (via /api/media/upload) e guarda a URL.
  async function uploadImage(file: File) {
    setUploadingImg(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('bucket', 'media')
      const res = await fetch('/api/media/upload', { method: 'POST', body: fd })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.publicUrl) {
        setDraft((d) => ({ ...d, imageUrl: data.publicUrl }))
      } else toast.error(data.error ?? 'Falha ao enviar a imagem.')
    } catch {
      toast.error('Falha ao enviar a imagem.')
    } finally {
      setUploadingImg(false)
    }
  }

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
      unitPrice: p.unit_price ? formatBrlInput(p.unit_price) : '',
      linkUrl: p.link_url ?? '',
      imageUrl: p.image_url ?? '',
      active: p.active,
    })
    setFormOpen(true)
  }

  async function save() {
    if (!draft.name.trim()) {
      toast.error('O nome é obrigatório.')
      return
    }
    // Preço no formato BR (02/10/2026): o replace(',', '.') transformava
    // "1.028,67" em "1.028.67" → NaN → o item ia pro catálogo a R$ 0 calado.
    const price = parseBrlField(draft.unitPrice)
    if (price.invalid) {
      toast.error(`Não entendi o preço "${draft.unitPrice.trim()}". Use, por exemplo, 1.028,67.`)
      return
    }
    setSaving(true)
    const priceNum = price.value ?? 0
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      kind: draft.kind,
      unitPrice: priceNum,
      linkUrl: draft.linkUrl.trim() || null,
      imageUrl: draft.imageUrl.trim() || null,
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

  async function handleFile(file: File | undefined) {
    if (!file) return
    setImporting(true)
    try {
      // Preço (02/10/2026): linha com preço que não é número fica DE FORA e
      // aparece no aviso com a linha da planilha — antes entrava a R$ 0 calada
      // (lib/import/products-sheet).
      const { items: parsed, errors } = mapProductRows(await parseSheet(file))
      const errorLines = errors.slice(0, MAX_PRICE_ERRORS).map(formatMoneyError)
      if (errors.length > MAX_PRICE_ERRORS) {
        errorLines.push(`…e mais ${errors.length - MAX_PRICE_ERRORS}.`)
      }
      if (parsed.length === 0) {
        if (errors.length > 0) {
          // Toast não quebra linha — a lista vai separada por ";".
          toast.error('Nenhum item com preço que eu entenda. Use, por exemplo, 1.028,67.', {
            description: errorLines.join('; '),
          })
        } else {
          toast.error(
            'Não achei itens. A planilha precisa de uma coluna de nome (ex.: "Nome do produto").',
          )
        }
        return
      }
      const priceWarning =
        errors.length > 0
          ? `\n\n${errors.length} ${errors.length === 1 ? 'linha tem' : 'linhas têm'} preço que não entendi e ${errors.length === 1 ? 'fica' : 'ficam'} DE FORA (corrija na planilha, ex.: 1.028,67, e importe de novo):\n${errorLines.join('\n')}`
          : ''
      if (
        !window.confirm(
          `Importar ${parsed.length} ${parsed.length === 1 ? 'item' : 'itens'} do arquivo "${file.name}"? Itens com nome já existente são ignorados.${priceWarning}`,
        )
      )
        return
      const res = await importProducts(parsed)
      if (res.error) {
        toast.error(res.error)
        return
      }
      toast.success(
        `${res.created} importado${res.created === 1 ? '' : 's'}${
          res.skipped > 0 ? ` · ${res.skipped} ignorado(s)` : ''
        }${errors.length > 0 ? ` · ${errors.length} com preço inválido (fora)` : ''}`,
      )
      await load()
    } catch {
      toast.error('Não consegui ler o arquivo. Use CSV ou XLSX.')
    } finally {
      setImporting(false)
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // permite reimportar o mesmo arquivo
    void handleFile(file)
  }

  function exportCsv() {
    if (items.length === 0) {
      toast('Catálogo vazio — nada para exportar.')
      return
    }
    downloadCsv(
      'produtos_servicos.csv',
      ['Nome do produto', 'Preço', 'Descrição', 'Tipo'],
      items.map((p) => [
        p.name,
        p.unit_price,
        p.description ?? '',
        p.kind === 'service' ? 'Serviço' : 'Produto',
      ]),
    )
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
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={onFile}
            className="hidden"
          />
          <Button variant="outline" onClick={exportCsv}>
            <Download className="mr-1.5 h-4 w-4" /> Exportar
          </Button>
          <Button
            variant="outline"
            onClick={() => fileRef.current?.click()}
            disabled={importing}
          >
            {importing ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-1.5 h-4 w-4" />
            )}
            Importar
          </Button>
          <Button onClick={openNew}>
            <Plus className="mr-1.5 h-4 w-4" /> Novo
          </Button>
        </div>
      </div>

      {/* Solta um CSV/XLSX aqui (ou use Importar). */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void handleFile(e.dataTransfer.files?.[0])
        }}
        className={`flex items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-3 text-xs transition-colors ${
          dragging
            ? 'border-primary bg-primary/5 text-primary'
            : 'border-border text-muted-foreground'
        }`}
      >
        <Upload className="h-4 w-4" />
        Arraste um CSV/XLSX aqui (colunas <strong>Nome</strong>,{' '}
        <strong>Preço</strong>, <strong>Descrição</strong>) ou use{' '}
        <strong>Importar</strong>.
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
                {/* Formata ao sair ("1028.67" → "1.028,67") e marca o que
                    não é número (02/10/2026). */}
                <MoneyInput
                  id="prod-price"
                  value={draft.unitPrice}
                  onValueChange={(t) =>
                    setDraft((d) => ({ ...d, unitPrice: t }))
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
            <div>
              <Label htmlFor="prod-link">Link do produto</Label>
              <Input
                id="prod-link"
                type="url"
                value={draft.linkUrl}
                onChange={(e) => setDraft({ ...draft, linkUrl: e.target.value })}
                placeholder="https://… (página ou checkout — o agente de Vendas envia ao cliente)"
              />
            </div>
            <div>
              <Label>Foto do produto</Label>
              <div className="mt-1 flex items-center gap-3">
                {draft.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={draft.imageUrl}
                    alt="Foto do produto"
                    className="h-16 w-16 rounded-md border border-border object-cover"
                  />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-border text-[10px] text-muted-foreground">
                    sem foto
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => imgRef.current?.click()}
                    disabled={uploadingImg}
                  >
                    {uploadingImg ? 'Enviando…' : draft.imageUrl ? 'Trocar foto' : 'Enviar foto'}
                  </Button>
                  {draft.imageUrl && (
                    <button
                      type="button"
                      onClick={() => setDraft({ ...draft, imageUrl: '' })}
                      className="text-xs text-destructive hover:underline"
                    >
                      Remover
                    </button>
                  )}
                </div>
                <input
                  ref={imgRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void uploadImage(f)
                    e.target.value = ''
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                O agente de Vendas envia essa imagem como anexo quando falar deste
                produto.
              </p>
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
