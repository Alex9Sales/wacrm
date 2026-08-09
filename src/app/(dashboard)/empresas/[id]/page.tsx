'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  getCompany,
  deleteCompany,
  type CompanyDetail,
} from '../actions'
import { CompanyForm } from '@/components/empresas/company-form'
import { Button } from '@/components/ui/button'
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

export default function EmpresaDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params?.id
  const router = useRouter()
  const [company, setCompany] = useState<CompanyDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [editOpen, setEditOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    const c = await getCompany(id).catch(() => null)
    setCompany(c)
    setLoading(false)
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

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

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Contatos</p>
          <p className="mt-1 text-2xl font-semibold text-foreground">
            {company.contacts.length}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Negócios</p>
          <p className="mt-1 text-2xl font-semibold text-foreground">
            {company.deals.length}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Em aberto</p>
          <p className="mt-1 text-2xl font-semibold text-foreground">
            {brl(company.open_deals_value)}
          </p>
        </div>
      </div>

      {/* Dados */}
      {(company.website || company.phone || company.notes) && (
        <div className="space-y-2 rounded-xl border border-border bg-card p-4">
          {company.phone && (
            <p className="flex items-center gap-2 text-sm text-foreground">
              <Phone className="h-4 w-4 text-muted-foreground" /> {company.phone}
            </p>
          )}
          {company.website && (
            <p className="flex items-center gap-2 text-sm text-foreground">
              <Globe className="h-4 w-4 text-muted-foreground" /> {company.website}
            </p>
          )}
          {company.notes && (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {company.notes}
            </p>
          )}
        </div>
      )}

      {/* Contatos */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Users className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Contatos</h2>
          <span className="text-xs text-muted-foreground">
            ({company.contacts.length})
          </span>
        </div>
        {company.contacts.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            Nenhum contato nesta empresa. Vincule contatos pelo campo “Empresa”
            de cada contato.
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
            Nenhum negócio vinculado (via contatos desta empresa).
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
          }}
          onSaved={() => void load()}
        />
      )}
    </div>
  )
}
