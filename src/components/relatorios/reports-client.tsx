'use client'

// ============================================================
// Relatórios — cliente do dashboard COMERCIAL.
// Leitura Z: KPIs no topo → funil-herói no centro → tendência +
// motivos de perda → performance por responsável. Título-insight
// (conclusão gerada dos números) logo abaixo dos filtros.
// ============================================================

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  Download,
  TrendingUp,
  Trophy,
  Percent,
  Receipt,
  AlertTriangle,
  Wallet,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatCurrency, formatCurrencyShort } from '@/lib/currency'
import { downloadCsv } from '@/lib/import/sheet'
import {
  getComercialReport,
  listReportFilters,
  type ComercialReport,
  type ReportFilterOptions,
} from '@/app/(dashboard)/relatorios/actions'

// Cores semânticas fixas (verde=venda, vermelho=perda…) — estáveis em
// qualquer tema de destaque da conta, como no RD.
const C = {
  won: '#10b981',
  lost: '#ef4444',
  open: '#f59e0b',
  created: '#6366f1',
} as const
const PIE_PALETTE = ['#ef4444', '#f59e0b', '#6366f1', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b']

const REPORT_TYPES = [
  { id: 'comercial', label: 'Comercial', enabled: true },
  { id: 'financeiro', label: 'Financeiro', enabled: false },
  { id: 'clientes', label: 'Clientes', enabled: false },
] as const

type Preset = '7d' | '30d' | '90d' | 'mes' | 'mes_passado' | 'ano' | 'custom'
const PRESETS: { id: Preset; label: string }[] = [
  { id: '7d', label: 'Últimos 7 dias' },
  { id: '30d', label: 'Últimos 30 dias' },
  { id: '90d', label: 'Últimos 90 dias' },
  { id: 'mes', label: 'Este mês' },
  { id: 'mes_passado', label: 'Mês passado' },
  { id: 'ano', label: 'Este ano' },
  { id: 'custom', label: 'Personalizado' },
]

function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function rangeForPreset(p: Preset, from: string, to: string): { from: string; to: string } {
  const now = new Date()
  const today = ymd(now)
  if (p === 'custom') return { from, to }
  if (p === '7d') return { from: ymd(new Date(now.getTime() - 6 * 864e5)), to: today }
  if (p === '30d') return { from: ymd(new Date(now.getTime() - 29 * 864e5)), to: today }
  if (p === '90d') return { from: ymd(new Date(now.getTime() - 89 * 864e5)), to: today }
  if (p === 'mes') return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: today }
  if (p === 'mes_passado') {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const last = new Date(now.getFullYear(), now.getMonth(), 0)
    return { from: ymd(first), to: ymd(last) }
  }
  // ano
  return { from: ymd(new Date(now.getFullYear(), 0, 1)), to: today }
}

/** Rótulo curto do bucket da série conforme a granularidade. */
function bucketLabel(iso: string, gran: 'day' | 'week' | 'month'): string {
  const [y, m, d] = iso.split('-')
  if (gran === 'month') {
    const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
    return `${MES[Number(m) - 1] ?? m}/${y.slice(2)}`
  }
  return `${d}/${m}`
}

export function ReportsClient() {
  const [options, setOptions] = useState<ReportFilterOptions | null>(null)
  const [loadingOpts, setLoadingOpts] = useState(true)

  useEffect(() => {
    let alive = true
    listReportFilters()
      .then((o) => {
        if (alive) setOptions(o)
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoadingOpts(false)
      })
    return () => {
      alive = false
    }
  }, [])

  if (loadingOpts) {
    return <div className="py-20 text-center text-sm text-muted-foreground">Carregando…</div>
  }
  if (!options || options.pipelines.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
        Crie um funil de vendas primeiro para ver os relatórios.
      </div>
    )
  }
  return <ReportsInner options={options} />
}

function ReportsInner({ options }: { options: ReportFilterOptions }) {
  const [pipelineId, setPipelineId] = useState(options.defaultPipelineId ?? '')
  const [responsavelId, setResponsavelId] = useState('all')
  const [preset, setPreset] = useState<Preset>('30d')
  const initial = rangeForPreset('30d', '', '')
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [report, setReport] = useState<ComercialReport | null>(null)
  const [pending, startTransition] = useTransition()
  const [reportType, setReportType] = useState<string>('comercial')

  const currency = report?.currency ?? options.defaultCurrency

  const load = useCallback(() => {
    if (!pipelineId) return
    startTransition(async () => {
      const r = await getComercialReport({ pipelineId, responsavelId, from, to })
      setReport(r)
    })
  }, [pipelineId, responsavelId, from, to])

  // Recarrega quando os filtros mudam.
  useEffect(() => {
    load()
  }, [load])

  const onPreset = (p: Preset) => {
    setPreset(p)
    if (p !== 'custom') {
      const r = rangeForPreset(p, from, to)
      setFrom(r.from)
      setTo(r.to)
    }
  }

  const money = (v: number) => formatCurrency(v, currency)
  const moneyShort = (v: number) => formatCurrencyShort(v, currency)

  const exportCsv = () => {
    if (!report) return
    const rows: (string | number)[][] = []
    rows.push(['— KPIs —', ''])
    rows.push(['Negócios criados', report.kpis.criadas])
    rows.push(['Valor criado', report.kpis.valorCriado])
    rows.push(['Vendas', report.kpis.vendas])
    rows.push(['Valor de vendas', report.kpis.valorVendas])
    rows.push(['Perdas', report.kpis.perdas])
    rows.push(['Valor perdido', report.kpis.valorPerdas])
    rows.push(['Taxa de conversão (%)', Math.round(report.kpis.conversao * 100)])
    rows.push(['Ticket médio', report.kpis.ticketMedio])
    rows.push(['Valor em aberto', report.kpis.valorEmAberto])
    rows.push(['', ''])
    rows.push(['— Funil por etapa —', ''])
    for (const f of report.funnel) {
      rows.push([`${f.name} · total`, f.total])
      rows.push([`${f.name} · abertos`, f.open])
      rows.push([`${f.name} · valor aberto`, f.openValue])
      rows.push([`${f.name} · perda (%)`, Math.round(f.lossRate * 100)])
    }
    rows.push(['', ''])
    rows.push(['— Motivos de perda —', ''])
    for (const l of report.lossReasons) rows.push([l.reason, l.count])
    rows.push(['', ''])
    rows.push(['— Por responsável —', 'criadas | ganhas | perdidas | valor ganho'])
    for (const r of report.responsaveis)
      rows.push([r.name, `${r.criadas} | ${r.ganhas} | ${r.perdidas} | ${r.valorGanho}`])
    downloadCsv(`relatorio-comercial-${from}_a_${to}.csv`, ['Métrica', 'Valor'], rows)
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Tipo de relatório (estilo RD) */}
      <div className="flex flex-wrap items-center gap-2">
        {REPORT_TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            disabled={!t.enabled}
            onClick={() => t.enabled && setReportType(t.id)}
            className={[
              'rounded-full px-4 py-1.5 text-sm font-medium transition',
              reportType === t.id
                ? 'bg-primary text-primary-foreground'
                : t.enabled
                  ? 'bg-muted text-foreground hover:bg-muted/70'
                  : 'cursor-not-allowed bg-muted/40 text-muted-foreground',
            ].join(' ')}
          >
            {t.label}
            {!t.enabled && <span className="ml-1.5 text-[10px] opacity-70">em breve</span>}
          </button>
        ))}
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Funil">
          <Select value={pipelineId} onValueChange={(v) => v && setPipelineId(v)}>
            <SelectTrigger className="w-52">
              <SelectValue placeholder="Selecione o funil" />
            </SelectTrigger>
            <SelectContent>
              {options.pipelines.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {options.canFilterResponsavel && (
          <Field label="Responsável">
            <Select value={responsavelId} onValueChange={(v) => v && setResponsavelId(v)}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                {options.responsaveis.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}

        <Field label="Período">
          <Select value={preset} onValueChange={(v) => v && onPreset(v as Preset)}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {preset === 'custom' && (
          <>
            <Field label="De">
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              />
            </Field>
            <Field label="Até">
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              />
            </Field>
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" onClick={exportCsv} disabled={!report}>
            <Download className="mr-1.5 h-4 w-4" /> CSV
          </Button>
        </div>
      </div>

      {/* Título-insight */}
      {report && (
        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
          <span className="font-medium text-foreground">{report.insight}</span>
        </div>
      )}

      {!report && pending && (
        <div className="py-20 text-center text-sm text-muted-foreground">Carregando relatório…</div>
      )}

      {report && (
        <>
          {/* KPIs (leitura Z — topo) */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              icon={<TrendingUp className="h-4 w-4" />}
              label="Negócios criados"
              value={String(report.kpis.criadas)}
              sub={money(report.kpis.valorCriado)}
              tone="neutral"
            />
            <Kpi
              icon={<Trophy className="h-4 w-4" />}
              label="Vendas"
              value={String(report.kpis.vendas)}
              sub={money(report.kpis.valorVendas)}
              tone="good"
            />
            <Kpi
              icon={<Percent className="h-4 w-4" />}
              label="Taxa de conversão"
              value={`${Math.round(report.kpis.conversao * 100)}%`}
              sub="só negócios encerrados"
              tone="neutral"
            />
            <Kpi
              icon={<Receipt className="h-4 w-4" />}
              label="Ticket médio"
              value={moneyShort(report.kpis.ticketMedio)}
              sub={`${report.kpis.vendas} venda(s)`}
              tone="neutral"
            />
          </div>
          {/* KPIs secundários */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              icon={<Wallet className="h-4 w-4" />}
              label="Valor em aberto"
              value={moneyShort(report.kpis.valorEmAberto)}
              sub={`${report.kpis.abertas} em aberto`}
              tone="warn"
              small
            />
            <Kpi
              icon={<AlertTriangle className="h-4 w-4" />}
              label="Perdas"
              value={String(report.kpis.perdas)}
              sub={money(report.kpis.valorPerdas)}
              tone="bad"
              small
            />
          </div>

          {/* Funil-herói */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Funil — onde a venda trava</span>
                <span className="text-xs font-normal text-muted-foreground">
                  negócios criados no período
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <FunnelHero report={report} money={money} />
            </CardContent>
          </Card>

          {/* Tendência + Motivos de perda */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Criadas × Ganhas no tempo</CardTitle>
              </CardHeader>
              <CardContent>
                {report.timeseries.length === 0 ? (
                  <Empty />
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart
                      data={report.timeseries.map((t) => ({
                        ...t,
                        label: bucketLabel(t.bucket, report.timeGranularity),
                      }))}
                      margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="gCriadas" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={C.created} stopOpacity={0.35} />
                          <stop offset="95%" stopColor={C.created} stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="gGanhas" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={C.won} stopOpacity={0.35} />
                          <stop offset="95%" stopColor={C.won} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
                      <RTooltip content={<ChartTip />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area
                        type="monotone"
                        name="Criadas"
                        dataKey="criadas"
                        stroke={C.created}
                        fill="url(#gCriadas)"
                        strokeWidth={2}
                      />
                      <Area
                        type="monotone"
                        name="Ganhas"
                        dataKey="ganhas"
                        stroke={C.won}
                        fill="url(#gGanhas)"
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Motivos de perda</CardTitle>
              </CardHeader>
              <CardContent>
                {report.lossReasons.length === 0 ? (
                  <Empty label="Nenhuma perda no período" />
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <PieChart>
                      <Pie
                        data={report.lossReasons}
                        dataKey="count"
                        nameKey="reason"
                        cx="50%"
                        cy="50%"
                        innerRadius={45}
                        outerRadius={85}
                        paddingAngle={2}
                      >
                        {report.lossReasons.map((_, i) => (
                          <Cell key={i} fill={PIE_PALETTE[i % PIE_PALETTE.length]} />
                        ))}
                      </Pie>
                      <RTooltip content={<ChartTip suffix=" negócio(s)" />} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Desempenho por responsável */}
          <Card>
            <CardHeader>
              <CardTitle>Desempenho por responsável</CardTitle>
            </CardHeader>
            <CardContent>
              {report.responsaveis.length === 0 ? (
                <Empty />
              ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                  <ResponsiveContainer width="100%" height={Math.max(180, report.responsaveis.length * 42)}>
                    <BarChart
                      layout="vertical"
                      data={report.responsaveis}
                      margin={{ top: 4, right: 12, left: 8, bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                      <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={110}
                        tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                      />
                      <RTooltip content={<ChartTip />} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar name="Ganhas" dataKey="ganhas" fill={C.won} radius={[0, 4, 4, 0]} />
                      <Bar name="Perdidas" dataKey="perdidas" fill={C.lost} radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="py-2 pr-2 font-medium">Responsável</th>
                          <th className="py-2 px-2 text-right font-medium">Criadas</th>
                          <th className="py-2 px-2 text-right font-medium">Ganhas</th>
                          <th className="py-2 px-2 text-right font-medium">Perdidas</th>
                          <th className="py-2 pl-2 text-right font-medium">Valor ganho</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.responsaveis.map((r) => (
                          <tr key={r.id} className="border-b border-border/60">
                            <td className="py-2 pr-2">{r.name}</td>
                            <td className="py-2 px-2 text-right tabular-nums">{r.criadas}</td>
                            <td className="py-2 px-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                              {r.ganhas}
                            </td>
                            <td className="py-2 px-2 text-right tabular-nums text-red-600 dark:text-red-400">
                              {r.perdidas}
                            </td>
                            <td className="py-2 pl-2 text-right tabular-nums font-medium">
                              {money(r.valorGanho)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

// ---------- subcomponentes ----------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function Kpi({
  icon,
  label,
  value,
  sub,
  tone,
  small,
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub: string
  tone: 'neutral' | 'good' | 'bad' | 'warn'
  small?: boolean
}) {
  const toneCls =
    tone === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'bad'
        ? 'text-red-600 dark:text-red-400'
        : tone === 'warn'
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-foreground'
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={toneCls}>{icon}</span>
          {label}
        </div>
        <div className={`font-heading font-semibold tabular-nums ${small ? 'text-xl' : 'text-2xl'} ${toneCls}`}>
          {value}
        </div>
        <div className="text-xs text-muted-foreground">{sub}</div>
      </CardContent>
    </Card>
  )
}

function FunnelHero({
  report,
  money,
}: {
  report: ComercialReport
  money: (v: number) => string
}) {
  const maxTotal = Math.max(1, ...report.funnel.map((f) => f.total))
  if (report.funnel.every((f) => f.total === 0)) return <Empty />
  return (
    <div className="flex flex-col gap-2">
      {report.funnel.map((f) => {
        const width = Math.max(6, Math.round((f.total / maxTotal) * 100))
        return (
          <div key={f.stageId} className="flex items-center gap-3">
            <div className="w-36 shrink-0 truncate text-sm" title={f.name}>
              {f.name}
              {f.isLossHotspot && (
                <span className="ml-1 inline-flex items-center rounded bg-red-500/15 px-1 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
                  maior perda
                </span>
              )}
            </div>
            <div className="relative h-8 flex-1 overflow-hidden rounded-md bg-muted">
              <div
                className={`h-full rounded-md ${f.isLossHotspot ? 'bg-red-500/25' : 'bg-primary/20'}`}
                style={{ width: `${width}%` }}
              />
              <div className="absolute inset-0 flex items-center gap-2 px-2 text-xs">
                <span className="font-semibold tabular-nums">{f.total}</span>
                <span className="text-muted-foreground">·</span>
                <span className="tabular-nums text-muted-foreground">{money(f.openValue)} aberto</span>
                {f.lost > 0 && (
                  <span className="ml-auto tabular-nums text-red-600 dark:text-red-400">
                    {Math.round(f.lossRate * 100)}% perda
                  </span>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

type TipPayload = { name: string; value: number | string; color?: string }
function ChartTip({
  active,
  payload,
  label,
  suffix = '',
}: {
  active?: boolean
  payload?: TipPayload[]
  label?: string
  suffix?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      {label && <div className="mb-1 font-medium">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color ?? '#888' }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-medium tabular-nums">
            {p.value}
            {suffix}
          </span>
        </div>
      ))}
    </div>
  )
}

function Empty({ label = 'Sem dados no período' }: { label?: string }) {
  return (
    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">{label}</div>
  )
}
