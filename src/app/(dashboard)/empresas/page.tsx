'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { listCompanies, type CompanyRow } from './actions'
import { CompanyForm } from '@/components/empresas/company-form'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Building2, Plus, Search, Users, GitBranch, Loader2 } from 'lucide-react'

export default function EmpresasPage() {
  const [companies, setCompanies] = useState<CompanyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [formOpen, setFormOpen] = useState(false)

  const load = useCallback(async (term: string) => {
    setLoading(true)
    const rows = await listCompanies(term).catch(() => [] as CompanyRow[])
    setCompanies(rows)
    setLoading(false)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void load(search), 250)
    return () => clearTimeout(t)
  }, [search, load])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Empresas</h1>
          <p className="text-sm text-muted-foreground">
            Agrupe contatos e negócios por empresa.
          </p>
        </div>
        <Button onClick={() => setFormOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" /> Nova empresa
        </Button>
      </div>

      <div className="relative w-full max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar empresa…"
          className="pl-9"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : companies.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-16 text-center">
          <Building2 className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">
            {search ? 'Nenhuma empresa encontrada.' : 'Nenhuma empresa ainda.'}
          </p>
          {!search && (
            <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
              Crie empresas para organizar seus contatos e negócios. Contatos com
              o campo “Empresa” preenchido já foram agrupados automaticamente.
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {companies.map((c) => (
            <Link
              key={c.id}
              href={`/empresas/${c.id}`}
              className="group rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-muted/40"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Building2 className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground group-hover:text-primary">
                    {c.name}
                  </p>
                  {c.segment && (
                    <p className="truncate text-xs text-muted-foreground">
                      {c.segment}
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Users className="h-3.5 w-3.5" />
                  {c.contacts_count}{' '}
                  {c.contacts_count === 1 ? 'contato' : 'contatos'}
                </span>
                <span className="inline-flex items-center gap-1">
                  <GitBranch className="h-3.5 w-3.5" />
                  {c.deals_count}{' '}
                  {c.deals_count === 1 ? 'negócio' : 'negócios'}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {formOpen && (
        <CompanyForm
          open={formOpen}
          onOpenChange={setFormOpen}
          onSaved={() => void load(search)}
        />
      )}
    </div>
  )
}
