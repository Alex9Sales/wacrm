'use client';

// ============================================================
// Fase B — Painel "Uso de LLM" (medidor de custo da IA), inspirado no
// dashboard do fazer.ai/agents. Lê /api/ai/usage (agrega `ai_usage`, custo
// derivado local). Custo é sensível → a rota já gateia a supervisor+.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Loader2,
  Coins,
  Receipt,
  Hash,
  MessagesSquare,
  Bot,
  Target,
  ArrowRightLeft,
  ShoppingCart,
  Wrench,
} from 'lucide-react';

interface Dashboard {
  rangeDays: number;
  source: string;
  usdBrlRate: number;
  totals: {
    costUsd: number;
    costBrl: number;
    calls: number;
    conversations: number;
    promptTokens: number;
    completionTokens: number;
    cachedReadTokens: number;
    cacheCreationTokens: number;
  };
  costPerConversationUsd: number;
  costPerConversationBrl: number;
  daily: { date: string; costUsd: number; costBrl: number; calls: number }[];
  byModel: {
    model: string;
    calls: number;
    costUsd: number;
    promptTokens: number;
    completionTokens: number;
    estimated: boolean;
  }[];
  byAgent: {
    agentId: string | null;
    name: string;
    calls: number;
    costUsd: number;
    conversations: number;
  }[];
  byChannel: {
    channelId: string | null;
    name: string;
    calls: number;
    costUsd: number;
    conversations: number;
  }[];
  status: { open: number; pending: number; closed: number };
  quality: {
    toolCalls: number;
    toolCallsPerConversation: number;
    ordersCreated: number;
    handoffs: number;
    handoffRatePct: number;
    aiOnlyConversations: number;
    aiOnlyPct: number;
  };
  funnel?: {
    total: number;
    aiEngaged: number;
    aiResolved: number;
    transferred: number;
  };
}

/** % inteiro seguro (0 quando o total é 0). */
const pct = (part: number, total: number) =>
  total > 0 ? Math.round((part / total) * 100) : 0;

const brl = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const usd = (v: number) =>
  v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const int = (v: number) => v.toLocaleString('pt-BR');
const ddmm = (iso: string) => {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
};

const RANGES = [
  { days: 7, label: '7 dias' },
  { days: 30, label: '30 dias' },
  { days: 90, label: '90 dias' },
];
const SOURCES = [
  { key: 'real', label: 'Real' },
  { key: 'playground', label: 'Playground' },
  { key: 'all', label: 'Todos' },
];

export function UsageDashboard() {
  const [days, setDays] = useState(30);
  const [source, setSource] = useState('real');
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ai/usage?days=${days}&source=${source}`);
      const json = await res.json();
      if (res.ok) setData(json as Dashboard);
      else setError(json.error ?? 'Falha ao carregar o uso.');
    } catch {
      setError('Falha ao carregar o uso.');
    } finally {
      setLoading(false);
    }
  }, [days, source]);

  useEffect(() => {
    void load();
  }, [load]);

  const chartData = useMemo(
    () =>
      (data?.daily ?? []).map((d) => ({
        label: ddmm(d.date),
        custo: Number(d.costBrl.toFixed(4)),
        atend: d.calls,
      })),
    [data],
  );

  return (
    <div className="space-y-4">
      {/* filtros */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          options={RANGES.map((r) => ({ key: String(r.days), label: r.label }))}
          value={String(days)}
          onChange={(v) => setDays(Number(v))}
        />
        <Segmented options={SOURCES} value={source} onChange={setSource} />
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Carregando uso…
        </div>
      )}

      {error && !loading && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {data && !loading && (
        <>
          {/* Funil de automação (Fase 4) — quanto a IA resolve sozinha. */}
          {data.funnel && (
            <div>
              <p className="mb-2 text-sm font-medium text-muted-foreground">
                Funil de automação
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Kpi
                  icon={<MessagesSquare className="h-4 w-4" />}
                  label="Conversas"
                  value={int(data.funnel.total)}
                  sub="no período"
                />
                <Kpi
                  icon={<Bot className="h-4 w-4" />}
                  label="Envolvimento"
                  value={`${pct(data.funnel.aiEngaged, data.funnel.total)}%`}
                  sub={`${int(data.funnel.aiEngaged)} de ${int(
                    data.funnel.total,
                  )} atendidas pela IA`}
                />
                <Kpi
                  icon={<Target className="h-4 w-4" />}
                  label="Resolução"
                  value={`${pct(data.funnel.aiResolved, data.funnel.total)}%`}
                  sub={`${int(
                    data.funnel.aiResolved,
                  )} resolvidas pela IA sem humano`}
                />
                <Kpi
                  icon={<ArrowRightLeft className="h-4 w-4" />}
                  label="Passaram por humano"
                  value={`${pct(data.funnel.transferred, data.funnel.total)}%`}
                  sub={`${int(
                    data.funnel.transferred,
                  )} em que alguém do time entrou`}
                />
              </div>
            </div>
          )}

          {/* KPIs */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi
              icon={<Coins className="h-4 w-4" />}
              label="Custo de LLM"
              value={brl(data.totals.costBrl)}
              sub={`${usd(data.totals.costUsd)} · ${int(data.totals.calls)} requisições`}
            />
            <Kpi
              icon={<Receipt className="h-4 w-4" />}
              label="Custo / conversa"
              value={brl(data.costPerConversationBrl)}
              sub={`${usd(data.costPerConversationUsd)} · em ${int(data.totals.conversations)} conversas`}
            />
            <Kpi
              icon={<Hash className="h-4 w-4" />}
              label="Tokens (entrada / saída)"
              value={`${int(data.totals.promptTokens)} / ${int(data.totals.completionTokens)}`}
              sub={`${int(data.totals.cachedReadTokens)} em cache${
                data.totals.cacheCreationTokens
                  ? ` · ${int(data.totals.cacheCreationTokens)} gravados`
                  : ''
              }`}
            />
            <Kpi
              icon={<MessagesSquare className="h-4 w-4" />}
              label="Conversas"
              value={int(data.totals.conversations)}
              sub={`Aberta ${data.status.open} · Pendente ${data.status.pending} · Resolvida ${data.status.closed}`}
            />
          </div>

          {/* gráfico diário */}
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 text-sm font-medium text-foreground">
              Custo diário (R$)
            </div>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="usageCost" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    interval="preserveStartEnd"
                    minTickGap={16}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    width={52}
                    tickFormatter={(v: number) => brl(v)}
                  />
                  <RTooltip
                    formatter={(v) => [brl(Number(v ?? 0)), 'Custo'] as [string, string]}
                    labelFormatter={(l) => `Dia ${l}`}
                    contentStyle={{
                      background: 'var(--popover)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      fontSize: 12,
                      color: 'var(--popover-foreground)',
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="custo"
                    stroke="var(--primary)"
                    strokeWidth={2}
                    fill="url(#usageCost)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Qualidade do atendimento — pra comparar modelos por QUALIDADE,
              não só custo (ex.: o luna manteve a taxa de transferência baixa?). */}
          <div>
            <div className="mb-2 text-sm font-medium text-foreground">
              Qualidade do atendimento
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Kpi
                icon={<Bot className="h-4 w-4" />}
                label="Atendidas só pela IA"
                value={`${data.quality.aiOnlyPct.toFixed(0)}%`}
                sub={`${int(data.quality.aiOnlyConversations)} de ${int(
                  data.totals.conversations,
                )} sem humano`}
              />
              <Kpi
                icon={<ArrowRightLeft className="h-4 w-4" />}
                label="A IA pediu ajuda"
                value={int(data.quality.handoffs)}
                sub={
                  data.quality.handoffs === 0
                    ? 'nenhuma vez — ela nunca transferiu sozinha'
                    : `${data.quality.handoffRatePct.toFixed(0)}% das conversas`
                }
              />
              <Kpi
                icon={<ShoppingCart className="h-4 w-4" />}
                label="Pedidos criados pela IA"
                value={int(data.quality.ordersCreated)}
                sub="no período"
              />
              <Kpi
                icon={<Wrench className="h-4 w-4" />}
                label="Ferramentas / conversa"
                value={data.quality.toolCallsPerConversation.toFixed(1)}
                sub={`${int(data.quality.toolCalls)} chamadas no total`}
              />
            </div>
          </div>

          {/* quebras */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <Breakdown
              title="Custo por modelo"
              rows={data.byModel.map((m) => ({
                name: m.model,
                costUsd: m.costUsd,
                meta: m.estimated
                  ? `${int(m.calls)} req · custo estimado`
                  : `${int(m.calls)} req`,
              }))}
            />
            <Breakdown
              title="Uso por agente"
              rows={data.byAgent.map((a) => ({
                name: a.name,
                costUsd: a.costUsd,
                meta: `${int(a.conversations)} conversas`,
              }))}
            />
            <Breakdown
              title="Uso por inbox"
              rows={data.byChannel.map((c) => ({
                name: c.name,
                costUsd: c.costUsd,
                meta: `${int(c.conversations)} conversas`,
              }))}
            />
          </div>

          <p className="text-[11px] text-muted-foreground">
            Custo estimado a partir dos tokens × tabela de preços por modelo
            (câmbio R$ {data.usdBrlRate.toFixed(2)}/US$). Fuso America/Sao_Paulo.
          </p>
        </>
      )}
    </div>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { key: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            value === o.key
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="text-xl font-bold tabular-nums text-foreground">{value}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}

function Breakdown({
  title,
  rows,
}: {
  title: string;
  rows: { name: string; costUsd: number; meta: string }[];
}) {
  const max = Math.max(...rows.map((r) => r.costUsd), 0.000001);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 text-sm font-medium text-foreground">{title}</div>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">Sem dados no período.</p>
      ) : (
        <div className="space-y-2.5">
          {rows.map((r) => (
            <div key={r.name}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="truncate text-xs text-foreground" title={r.name}>
                  {r.name}
                </span>
                <span className="shrink-0 text-xs font-semibold tabular-nums text-foreground">
                  {usd(r.costUsd)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${Math.max(2, (r.costUsd / max) * 100)}%` }}
                  />
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground">{r.meta}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
