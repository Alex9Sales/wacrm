'use client'

import { useState, useEffect, useCallback, type ComponentType } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  getCompany,
  deleteCompany,
  setContactCompany,
  listCompanyActivity,
  addCompanyNote,
  listCompanyAttachments,
  addCompanyAttachment,
  removeCompanyAttachment,
  setCompanyTags,
  type CompanyDetail,
  type CompanyEventRow,
  type CompanyAttachmentRow,
} from '../actions'
import {
  listContactsForPicker,
  type PickerOption,
} from '@/app/(dashboard)/tarefas/actions'
import { CompanyForm } from '@/components/empresas/company-form'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  ArrowLeft,
  Building2,
  Pencil,
  Trash2,
  Users,
  GitBranch,
  Globe,
  Phone,
  Loader2,
  ExternalLink,
  Plus,
  X,
  Mail,
  MapPin,
  FileText,
  UserRound,
  Tag as TagIcon,
  Paperclip,
  Clock,
  Trophy,
  Wallet,
  XCircle,
  Receipt,
} from 'lucide-react'

const STATUS_LABEL: Record<string, string> = {
  open: 'Aberto',
  won: 'Ganho',
  lost: 'Perdido',
}
const STATUS_CLASS: Record<string, string> = {
  open: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  won: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  lost: 'bg-red-500/10 text-red-600 dark:text-red-400',
}

function brl(n: number) {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function fmtDay(iso: string) {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}`
}

function fmtDateTime(iso: string) {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Texto de um evento do histórico da empresa. */
function eventText(ev: CompanyEventRow): string {
  if (ev.type === 'note') return String((ev.data as { text?: string }).text ?? '')
  const map: Record<string, string> = {
    deal_won: '🏆 Negócio ganho',
    deal_lost: '🔻 Negócio perdido',
    contact_added: '👤 Contato adicionado',
  }
  return map[ev.type] ?? ev.type
}

function Field({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: string
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate text-foreground">{value}</span>
    </div>
  )
}

export default function EmpresaDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params?.id
  const router = useRouter()
  const [company, setCompany] = useState<CompanyDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [editOpen, setEditOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // Seletor "Adicionar contato" à empresa (vincula contacts.company_id).
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQ, setPickerQ] = useState('')
  const [pickerOptions, setPickerOptions] = useState<PickerOption[]>([])
  const [busyContactId, setBusyContactId] = useState<string | null>(null)
  const [activity, setActivity] = useState<CompanyEventRow[]>([])
  const [attachments, setAttachments] = useState<CompanyAttachmentRow[]>([])
  const [note, setNote] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [newTag, setNewTag] = useState('')

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    const [c, act, atts] = await Promise.all([
      getCompany(id).catch(() => null),
      listCompanyActivity(id).catch(() => [] as CompanyEventRow[]),
      listCompanyAttachments(id).catch(() => [] as CompanyAttachmentRow[]),
    ])
    setCompany(c)
    setActivity(act)
    setAttachments(atts)
    setLoading(false)
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!pickerOpen) return
    setPickerQ('')
    listContactsForPicker()
      .then(setPickerOptions)
      .catch(() => setPickerOptions([]))
  }, [pickerOpen])

  async function linkContact(contactId: string) {
    if (!company) return
    setBusyContactId(contactId)
    const { error } = await setContactCompany(contactId, company.id)
    setBusyContactId(null)
    if (error) {
      toast.error(error)
      return
    }
    setPickerOpen(false)
    toast.success('Contato adicionado à empresa')
    await load()
  }

  async function unlinkContact(contactId: string) {
    setBusyContactId(contactId)
    const { error } = await setContactCompany(contactId, null)
    setBusyContactId(null)
    if (error) {
      toast.error(error)
      return
    }
    await load()
  }

  async function submitNote() {
    if (!company) return
    const t = note.trim()
    if (!t) return
    setSavingNote(true)
    const { error } = await addCompanyNote(company.id, t)
    setSavingNote(false)
    if (error) {
      toast.error(error)
      return
    }
    setNote('')
    setActivity(await listCompanyActivity(company.id).catch(() => activity))
  }

  async function uploadFile(file: File) {
    if (!company || uploading) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('bucket', 'media')
      const res = await fetch('/api/media/upload', { method: 'POST', body: fd })
      const data = (await res.json().catch(() => ({}))) as {
        publicUrl?: string
        error?: string
      }
      if (!res.ok || !data.publicUrl) {
        toast.error(data.error || 'Falha no upload do arquivo')
        return
      }
      const { error } = await addCompanyAttachment(company.id, {
        name: file.name,
        url: data.publicUrl,
        mime: file.type,
        size: file.size,
      })
      if (error) toast.error(error)
      else setAttachments(await listCompanyAttachments(company.id).catch(() => attachments))
    } finally {
      setUploading(false)
    }
  }

  async function deleteAttachment(attId: string) {
    const { error } = await removeCompanyAttachment(attId)
    if (error) {
      toast.error(error)
      return
    }
    setAttachments((prev) => prev.filter((a) => a.id !== attId))
  }

  async function saveTags(names: string[]) {
    if (!company) return
    const { error } = await setCompanyTags(company.id, names)
    if (error) {
      toast.error(error)
      return
    }
    await load()
  }

  async function handleDelete() {
    if (!company) return
    if (
      !window.confirm(
        `Excluir a empresa "${company.name}"? Os contatos e negócios continuam, só perdem o vínculo com ela.`,
      )
    )
      return
    setDeleting(true)
    const { error } = await deleteCompany(company.id)
    setDeleting(false)
    if (error) {
      toast.error(error)
      return
    }
    toast.success('Empresa excluída')
    router.push('/empresas')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  if (!company) {
    return (
      <div className="space-y-4">
        <Link
          href="/empresas"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Empresas
        </Link>
        <p className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          Empresa não encontrada.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Link
        href="/empresas"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Empresas
      </Link>

      {/* Cabeçalho */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Building2 className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">{company.name}</h1>
            {company.segment && (
              <p className="text-sm text-muted-foreground">{company.segment}</p>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil className="mr-1.5 h-4 w-4" /> Editar
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleDelete()}
            disabled={deleting}
            className="text-red-600 hover:text-red-600"
          >
            {deleting ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-1.5 h-4 w-4" />
            )}
            Excluir
          </Button>
        </div>
      </div>

      {/* Painel de métricas — mini raio-x da empresa */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Trophy className="h-3.5 w-3.5 text-emerald-500" /> Ganho
          </p>
          <p className="mt-1 text-2xl font-semibold text-emerald-600 dark:text-emerald-400">
            {brl(company.metrics.won_value)}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {company.metrics.won_count} negócio(s)
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Wallet className="h-3.5 w-3.5 text-amber-500" /> Em aberto
          </p>
          <p className="mt-1 text-2xl font-semibold text-foreground">
            {brl(company.metrics.open_value)}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {company.metrics.open_count} negócio(s)
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Receipt className="h-3.5 w-3.5 text-muted-foreground" /> Ticket médio
          </p>
          <p className="mt-1 text-2xl font-semibold text-foreground">
            {brl(company.metrics.ticket)}
          </p>
          <p className="text-[11px] text-muted-foreground">por venda ganha</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <XCircle className="h-3.5 w-3.5 text-red-500" /> Perdidos
          </p>
          <p className="mt-1 text-2xl font-semibold text-foreground">
            {company.metrics.lost_count}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {company.contacts.length} contato(s) ·{' '}
            {company.last_contact_at ? `visto ${fmtDay(company.last_contact_at)}` : 'sem contato'}
          </p>
        </div>
      </div>

      {/* Ficha (dados) + Etiquetas */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2.5 rounded-xl border border-border bg-card p-4">
          <h2 className="mb-1 text-sm font-semibold text-foreground">Dados</h2>
          <Field icon={UserRound} label="Responsável" value={company.assignee_name ?? '—'} />
          <Field icon={FileText} label="CNPJ / doc" value={company.document ?? '—'} />
          <Field icon={Mail} label="E-mail" value={company.email ?? '—'} />
          <Field icon={Phone} label="Telefone" value={company.phone ?? '—'} />
          <Field icon={Globe} label="Site" value={company.website ?? '—'} />
          <Field icon={MapPin} label="Endereço" value={company.address ?? '—'} />
          <Field icon={Building2} label="Porte" value={company.size ?? '—'} />
          {company.notes && (
            <p className="whitespace-pre-wrap pt-1 text-sm text-muted-foreground">
              {company.notes}
            </p>
          )}
        </div>

        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <TagIcon className="h-4 w-4 text-primary" /> Etiquetas
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {company.tags.length === 0 && (
              <span className="text-xs text-muted-foreground">Sem etiquetas.</span>
            )}
            {company.tags.map((t) => (
              <span
                key={t.id}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
                style={{ backgroundColor: `${t.color}22`, color: t.color }}
              >
                {t.name}
                <button
                  type="button"
                  onClick={() =>
                    void saveTags(
                      company.tags.map((x) => x.name).filter((n) => n !== t.name),
                    )
                  }
                  className="transition-opacity hover:opacity-60"
                  aria-label="Remover etiqueta"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newTag.trim()) {
                  e.preventDefault()
                  void saveTags([...company.tags.map((x) => x.name), newTag.trim()])
                  setNewTag('')
                }
              }}
              placeholder="Nova etiqueta…"
              className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!newTag.trim()}
              onClick={() => {
                if (newTag.trim()) {
                  void saveTags([...company.tags.map((x) => x.name), newTag.trim()])
                  setNewTag('')
                }
              }}
            >
              Adicionar
            </Button>
          </div>
        </div>
      </div>

      {/* Contatos */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Users className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Contatos</h2>
          <span className="text-xs text-muted-foreground">
            ({company.contacts.length})
          </span>
          <div className="ml-auto">
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted">
                <Plus className="h-3.5 w-3.5" /> Adicionar contato
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-0">
                <div className="border-b border-border p-2">
                  <input
                    autoFocus
                    value={pickerQ}
                    onChange={(e) => setPickerQ(e.target.value)}
                    placeholder="Buscar contato…"
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
                  />
                </div>
                <div className="max-h-52 overflow-y-auto p-1">
                  {(() => {
                    const already = new Set(company.contacts.map((c) => c.id))
                    const term = pickerQ.trim().toLowerCase()
                    const avail = pickerOptions
                      .filter((o) => !already.has(o.id))
                      .filter(
                        (o) =>
                          !term ||
                          o.label.toLowerCase().includes(term) ||
                          (o.sublabel ?? '').toLowerCase().includes(term),
                      )
                    if (avail.length === 0) {
                      return (
                        <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                          Nenhum contato.
                        </p>
                      )
                    }
                    return avail.slice(0, 50).map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => void linkContact(o.id)}
                        disabled={busyContactId === o.id}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted disabled:opacity-50"
                      >
                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                          {(o.label || '?').charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs text-foreground">
                            {o.label}
                          </p>
                          {o.sublabel && (
                            <p className="truncate text-[10px] text-muted-foreground">
                              {o.sublabel}
                            </p>
                          )}
                        </div>
                      </button>
                    ))
                  })()}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
        {company.contacts.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            Nenhum contato nesta empresa. Clique em <strong>Adicionar
            contato</strong> acima, ou preencha o campo “Empresa” de um contato.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {company.contacts.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                  {(c.name ?? c.phone).charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">
                    {c.name ?? c.phone}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.phone}
                    {c.email ? ` · ${c.email}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void unlinkContact(c.id)}
                  disabled={busyContactId === c.id}
                  title="Remover da empresa"
                  className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-red-600 disabled:opacity-50"
                >
                  {busyContactId === c.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <X className="h-3.5 w-3.5" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Negócios */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <GitBranch className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Negócios</h2>
          <span className="text-xs text-muted-foreground">
            ({company.deals.length})
          </span>
        </div>
        {company.deals.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            Nenhum negócio vinculado a esta empresa.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {company.deals.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/pipelines/${d.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{d.title}</p>
                    {d.contact_name && (
                      <p className="truncate text-xs text-muted-foreground">
                        {d.contact_name}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-sm font-medium text-foreground">
                    {brl(d.value)}
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      STATUS_CLASS[d.status] ?? 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {STATUS_LABEL[d.status] ?? d.status}
                  </span>
                  <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Atividade / histórico */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Clock className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Atividade</h2>
        </div>
        <div className="space-y-2 border-b border-border px-4 py-3">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Adicionar uma nota sobre a empresa…"
            rows={2}
            className="w-full resize-none rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary/50"
          />
          <div className="flex justify-end">
            <Button size="sm" disabled={!note.trim() || savingNote} onClick={() => void submitNote()}>
              {savingNote ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-1 h-4 w-4" />
              )}
              Anotar
            </Button>
          </div>
        </div>
        {activity.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            Sem atividade ainda.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {activity.map((ev) => (
              <li key={ev.id} className="px-4 py-2.5">
                <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                  {eventText(ev)}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {ev.actor_name ? `${ev.actor_name} · ` : ''}
                  {fmtDateTime(ev.created_at)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Anexos / arquivos */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Paperclip className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Arquivos</h2>
          <label className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted">
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Enviar arquivo
            <input
              type="file"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void uploadFile(f)
                e.target.value = ''
              }}
            />
          </label>
        </div>
        {attachments.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            Nenhum arquivo. Contrato, proposta e docs da empresa ficam aqui.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {attachments.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <a
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-sm text-foreground hover:underline"
                >
                  {a.name}
                </a>
                <button
                  type="button"
                  onClick={() => void deleteAttachment(a.id)}
                  className="shrink-0 text-muted-foreground transition-colors hover:text-red-600"
                  aria-label="Remover arquivo"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {editOpen && (
        <CompanyForm
          open={editOpen}
          onOpenChange={setEditOpen}
          company={{
            id: company.id,
            name: company.name,
            segment: company.segment,
            website: company.website,
            phone: company.phone,
            notes: company.notes,
            document: company.document,
            email: company.email,
            address: company.address,
            size: company.size,
            assignedTo: company.assigned_to,
          }}
          onSaved={() => void load()}
        />
      )}
    </div>
  )
}
