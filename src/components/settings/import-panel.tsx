'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import {
  importCompaniesContacts,
  importDeals,
  importTransactions,
  type ImportContactRow,
  type ImportDealRow,
  type ImportTransactionRow,
} from '@/app/(dashboard)/settings/import-actions'
import {
  exportContactsData,
  exportDealsData,
} from '@/app/(dashboard)/settings/import-actions'
import { listPipelines } from '@/app/(dashboard)/pipelines/actions'
import type { Pipeline } from '@/types'
import { parseSheet, downloadCsv } from '@/lib/import/sheet'
import { Button } from '@/components/ui/button'
import {
  Upload,
  Download,
  Loader2,
  Building2,
  Handshake,
  Users,
  CheckCircle2,
  Receipt,
} from 'lucide-react'

type ImportType = 'contacts' | 'deals' | 'transactions'

function norm(s: string) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}
function toNum(v: unknown): number {
  if (typeof v === 'number') return isFinite(v) ? v : 0
  const s = String(v ?? '').replace(/[^\d.,-]/g, '')
  if (!s) return 0
  const n = parseFloat(s.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'))
  return isFinite(n) ? n : 0
}

/** Casa cada campo a uma coluna do arquivo por regex tolerante ao cabeçalho. */
function mapColumns(keys: string[], spec: Record<string, RegExp>) {
  const map: Record<string, string | undefined> = {}
  for (const [field, re] of Object.entries(spec)) {
    map[field] = keys.find((k) => re.test(norm(k)))
  }
  return map
}

const CONTACT_SPEC: Record<string, RegExp> = {
  companyName: /organiza|empresa|company/,
  contactName: /contato|contact|^nome$|nome completo/,
  phone: /telefone|fone|phone|celular|whats/,
  email: /e-?mail/,
  segment: /segmento|segment|ramo/,
}
const DEAL_SPEC: Record<string, RegExp> = {
  title: /oportunidade|negocia|negocio|deal|titulo/,
  companyName: /organiza|empresa|company/,
  contactName: /nome do contato|contato|contact/,
  phone: /telefone|fone|phone|celular|whats/,
  email: /e-?mail/,
  source: /fonte|origem|source/,
  campaign: /campanha|campaign/,
  segment: /segmento|segment|ramo/,
  note: /anota|observa|^nota|note|coment/,
  responsible: /respons|vendedor|owner|dono/,
  stage: /etapa|estagio|fase|stage/,
  value: /valor|preco|price|amount/,
}
const TRANSACTION_SPEC: Record<string, RegExp> = {
  phone: /telefone|fone|phone|celular|whats/,
  contactName: /cliente|contato|contact|^nome/,
  occurredAt: /data|date|dia|quando/,
  amount: /valor|preco|price|amount|total/,
  product: /produto|servico|serviço|item|descri|product|marca/,
  paymentMethod: /pagamento|pagto|payment|forma/,
  externalId: /pedido|nº|numero|nota|external|order|venda/,
  type: /^tipo$|type/,
  status: /status|situacao|situação/,
}

export function ImportPanel() {
  const [type, setType] = useState<ImportType>('contacts')
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [pipelineId, setPipelineId] = useState('')
  const [rowsC, setRowsC] = useState<ImportContactRow[]>([])
  const [rowsD, setRowsD] = useState<ImportDealRow[]>([])
  const [rowsT, setRowsT] = useState<ImportTransactionRow[]>([])
  const [matched, setMatched] = useState<string[]>([])
  const [fileName, setFileName] = useState('')
  const [parsing, setParsing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    listPipelines()
      .then((p) => {
        setPipelines(p)
        if (p[0]) setPipelineId(p[0].id)
      })
      .catch(() => setPipelines([]))
  }, [])

  const reset = useCallback(() => {
    setRowsC([])
    setRowsD([])
    setRowsT([])
    setMatched([])
    setFileName('')
    setDone(null)
  }, [])

  async function handleFile(file: File | undefined) {
    if (!file) return
    setParsing(true)
    setDone(null)
    try {
      const json = await parseSheet(file)
      if (json.length === 0) {
        toast.error('Planilha vazia.')
        return
      }
      const keys = Object.keys(json[0])
      const spec =
        type === 'contacts'
          ? CONTACT_SPEC
          : type === 'transactions'
            ? TRANSACTION_SPEC
            : DEAL_SPEC
      const cmap = mapColumns(keys, spec)
      setMatched(
        Object.entries(cmap)
          .filter(([, v]) => v)
          .map(([f, v]) => `${f} ← ${v}`),
      )
      const get = (row: Record<string, unknown>, field: string) =>
        cmap[field] ? String(row[cmap[field]!] ?? '').trim() : ''
      if (type === 'contacts') {
        if (!cmap.companyName && !cmap.contactName && !cmap.phone) {
          toast.error(
            'Não achei colunas de Empresa/Contato. Cabeçalhos ex.: "Nome da Organização", "Nome do contato".',
          )
          return
        }
        setRowsC(
          json.map((r) => ({
            companyName: get(r, 'companyName') || null,
            contactName: get(r, 'contactName') || null,
            phone: get(r, 'phone') || null,
            email: get(r, 'email') || null,
            segment: get(r, 'segment') || null,
          })),
        )
      } else if (type === 'transactions') {
        if (!cmap.phone) {
          toast.error(
            'Preciso da coluna de Telefone do cliente. Cabeçalhos ex.: "Telefone", "Celular", "WhatsApp".',
          )
          return
        }
        setRowsT(
          json.map((r) => ({
            phone: get(r, 'phone') || null,
            contactName: get(r, 'contactName') || null,
            occurredAt: get(r, 'occurredAt') || null,
            amount: cmap.amount ? String(r[cmap.amount] ?? '') : null,
            product: get(r, 'product') || null,
            paymentMethod: get(r, 'paymentMethod') || null,
            externalId: get(r, 'externalId') || null,
            type: get(r, 'type') || null,
            status: get(r, 'status') || null,
          })),
        )
      } else {
        if (!cmap.title && !cmap.companyName && !cmap.contactName) {
          toast.error('Não achei coluna de Oportunidade/Empresa/Contato.')
          return
        }
        setRowsD(
          json.map((r) => ({
            title: get(r, 'title') || null,
            companyName: get(r, 'companyName') || null,
            contactName: get(r, 'contactName') || null,
            phone: get(r, 'phone') || null,
            email: get(r, 'email') || null,
            source: get(r, 'source') || null,
            campaign: get(r, 'campaign') || null,
            segment: get(r, 'segment') || null,
            note: get(r, 'note') || null,
            responsible: get(r, 'responsible') || null,
            stage: get(r, 'stage') || null,
            value: cmap.value ? toNum(r[cmap.value]) : 0,
          })),
        )
      }
      setFileName(file.name)
    } catch {
      toast.error('Não consegui ler o arquivo. Use CSV ou XLSX.')
    } finally {
      setParsing(false)
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    void handleFile(file)
  }

  async function exportData() {
    if (type === 'transactions') {
      toast.info('Exportação de histórico de vendas em breve.')
      return
    }
    setExporting(true)
    try {
      if (type === 'contacts') {
        const rows = await exportContactsData()
        downloadCsv(
          'empresas_e_contatos.csv',
          ['Nome da Organização', 'Nome do contato', 'Telefone do contato', 'E-mail do contato'],
          rows.map((r) => [r.company ?? '', r.name ?? '', r.phone ?? '', r.email ?? '']),
        )
      } else {
        if (!pipelineId) {
          toast.error('Escolha o funil para exportar.')
          return
        }
        const rows = await exportDealsData(pipelineId)
        downloadCsv(
          'negociacoes.csv',
          [
            'Nome da Oportunidade',
            'Nome da Organização',
            'Nome do contato',
            'Telefone do contato',
            'Valor',
            'Etapa',
            'Responsável',
            'Fonte da negociação',
          ],
          rows.map((r) => [
            r.title ?? '',
            r.company ?? '',
            r.contact_name ?? '',
            r.contact_phone ?? '',
            r.value ?? 0,
            r.stage ?? '',
            r.responsible ?? '',
            r.source ?? '',
          ]),
        )
      }
    } catch {
      toast.error('Falha ao exportar.')
    } finally {
      setExporting(false)
    }
  }

  const count =
    type === 'contacts'
      ? rowsC.length
      : type === 'transactions'
        ? rowsT.length
        : rowsD.length

  async function runImport() {
    if (count === 0) return
    setImporting(true)
    setDone(null)
    try {
      if (type === 'contacts') {
        const r = await importCompaniesContacts(rowsC)
        if (r.error) {
          toast.error(r.error)
          return
        }
        setDone(
          `${r.companiesCreated} empresa(s) e ${r.contactsCreated} contato(s) criados · ${r.contactsLinked} vinculado(s)${r.skipped ? ` · ${r.skipped} ignorado(s)` : ''}.`,
        )
      } else if (type === 'transactions') {
        const r = await importTransactions(rowsT)
        if (r.error) {
          toast.error(r.error)
          return
        }
        setDone(
          `${r.transactionsCreated} venda(s) importada(s)${r.transactionsUpdated ? ` · ${r.transactionsUpdated} atualizada(s)` : ''} · ${r.contactsCreated} cliente(s) novo(s)${r.skipped ? ` · ${r.skipped} ignorada(s)` : ''}.`,
        )
      } else {
        if (!pipelineId) {
          toast.error('Escolha o funil de destino.')
          return
        }
        const r = await importDeals(pipelineId, rowsD)
        if (r.error) {
          toast.error(r.error)
          return
        }
        setDone(
          `${r.dealsCreated} negócio(s) criados · ${r.companiesCreated} empresa(s) · ${r.contactsCreated} contato(s)${r.skipped ? ` · ${r.skipped} ignorado(s)` : ''}.`,
        )
      }
      toast.success('Importação concluída')
      setRowsC([])
      setRowsD([])
      setRowsT([])
      setFileName('')
      setMatched([])
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Importar dados</h2>
        <p className="text-sm text-muted-foreground">
          Traga dados de outro CRM por planilha (CSV ou XLSX).
        </p>
      </div>

      {/* Tipo */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(
          [
            {
              id: 'contacts' as const,
              icon: Building2,
              title: 'Empresas e contatos',
              desc: 'Organização, contato, telefone, e-mail, segmento.',
            },
            {
              id: 'transactions' as const,
              icon: Receipt,
              title: 'Histórico de vendas',
              desc: 'Compras/serviços do cliente: telefone, data, valor, produto, pagamento.',
            },
            {
              id: 'deals' as const,
              icon: Handshake,
              title: 'Negociações',
              desc: 'Oportunidades do funil: etapa, responsável, fonte, anotação.',
            },
          ]
        ).map((opt) => {
          const active = type === opt.id
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => {
                setType(opt.id)
                reset()
              }}
              className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-colors ${
                active
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-card hover:bg-muted/40'
              }`}
            >
              <opt.icon
                className={`h-5 w-5 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`}
              />
              <div>
                <p className="text-sm font-medium text-foreground">{opt.title}</p>
                <p className="text-xs text-muted-foreground">{opt.desc}</p>
              </div>
            </button>
          )
        })}
      </div>

      {/* Funil (só negociações) */}
      {type === 'deals' && pipelines.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-foreground">
            Funil de destino
          </label>
          <select
            value={pipelineId}
            onChange={(e) => setPipelineId(e.target.value)}
            className="w-full max-w-xs rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
          >
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground">
            A coluna “Etapa” casa por nome; sem correspondência, cai na 1ª etapa.
          </p>
        </div>
      )}

      {/* Upload (arrastar ou clicar) + Exportar */}
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={onFile}
        className="hidden"
      />
      <div className="flex flex-wrap items-center gap-2">
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
          onClick={() => fileRef.current?.click()}
          className={`flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-6 text-sm transition-colors ${
            dragging
              ? 'border-primary bg-primary/5 text-primary'
              : 'border-border text-muted-foreground hover:bg-muted/40'
          }`}
        >
          {parsing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          {fileName
            ? fileName
            : 'Arraste um CSV/XLSX aqui ou clique para escolher'}
        </div>
        <Button variant="outline" onClick={() => void exportData()} disabled={exporting}>
          {exporting ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-1.5 h-4 w-4" />
          )}
          Exportar
        </Button>
      </div>

      {/* Prévia */}
      {count > 0 && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Users className="h-4 w-4 text-primary" />
            {count} linha{count === 1 ? '' : 's'} pronta{count === 1 ? '' : 's'}{' '}
            para importar
          </p>
          {matched.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {matched.map((m) => (
                <span
                  key={m}
                  className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
                >
                  {m}
                </span>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            {type === 'transactions'
              ? 'Casa o cliente pelo telefone e liga a venda a ele (cria o cliente se não existir). Re-importar o mesmo arquivo não duplica.'
              : 'Empresas/contatos já existentes são reaproveitados (casa por nome / telefone) — não duplica.'}
          </p>
          <Button onClick={() => void runImport()} disabled={importing}>
            {importing && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Importar {count}
          </Button>
        </div>
      )}

      {done && (
        <div className="flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{done}</span>
        </div>
      )}
    </div>
  )
}
