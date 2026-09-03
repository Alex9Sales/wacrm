'use client';

// ============================================================
// "Precisa de você" — fila única de aprovação das ações da IA + métricas de
// autonomia + auditoria do que rodou sozinho (Fase 2). Cada item mostra
// cliente, negócio, ação, motivo, contexto, risco, recomendação (texto
// editável) e Aprovar / Recusar.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Bot,
  Check,
  ClipboardCheck,
  ExternalLink,
  Loader2,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  User,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  approveQueueItem,
  getAutonomyMetrics,
  listApprovalQueue,
  listRecentAudit,
  rejectQueueItem,
  type ApprovalItem,
  type AuditItem,
  type AutonomyMetrics,
} from '@/app/(dashboard)/aprovacoes/actions';
import type { Risk } from '@/lib/orchestration/policy';

const RISK_META: Record<Risk, { label: string; className: string }> = {
  low: { label: 'risco baixo', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  medium: { label: 'risco médio', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  high: { label: 'risco alto', className: 'bg-orange-500/15 text-orange-700 dark:text-orange-300' },
  critical: { label: 'crítico', className: 'bg-red-500/15 text-red-700 dark:text-red-300' },
};

const STATUS_LABEL: Record<string, string> = {
  sent: 'enviado',
  done: 'feito',
  rejected: 'recusado',
  blocked: 'bloqueado',
  failed: 'falhou',
  expired: 'expirou',
};

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function money(v: string | number): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '';
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(n);
  } catch {
    return String(n);
  }
}

function contextChips(p: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof p.hours_idle === 'number') out.push(`${Math.floor(p.hours_idle / 24)}d sem resposta`);
  if (p.viewed === true) out.push('proposta visualizada');
  if (typeof p.days_stale === 'number') out.push(`parado ${p.days_stale}d`);
  if (typeof p.days_since === 'number') out.push(`${p.days_since}d sem comprar`);
  if (typeof p.avg_days === 'number') out.push(`média ${p.avg_days}d`);
  if (typeof p.qualification === 'number') out.push(`qualificação ${p.qualification}/5`);
  if (typeof p.temperature === 'string' && p.temperature) out.push(String(p.temperature));
  if (typeof p.severity === 'number') out.push(`prioridade ${p.severity}`);
  return out;
}

export function ApprovalQueueClient() {
  const [items, setItems] = useState<ApprovalItem[] | null>(null);
  const [metrics, setMetrics] = useState<AutonomyMetrics | null>(null);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAudit, setShowAudit] = useState(false);

  const load = useCallback(async () => {
    try {
      const [q, m, a] = await Promise.all([listApprovalQueue(), getAutonomyMetrics(7), listRecentAudit(40)]);
      setItems(q);
      setMetrics(m);
      setAudit(a);
      setTexts((prev) => {
        const next = { ...prev };
        for (const it of q) if (next[it.id] === undefined && it.suggestedText) next[it.id] = it.suggestedText;
        return next;
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível carregar a fila.');
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const approve = async (it: ApprovalItem) => {
    setBusy(it.id);
    try {
      const r = await approveQueueItem({ id: it.id, text: it.isMessage ? texts[it.id] ?? it.suggestedText : null });
      if (!r.ok) toast.error(r.error);
      else toast.success(it.isMessage ? 'Mensagem enviada.' : `${it.actionLabel}: feito.`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não deu certo.');
    } finally {
      setBusy(null);
    }
  };

  const reject = async (it: ApprovalItem) => {
    setBusy(it.id);
    try {
      const r = await rejectQueueItem(it.id);
      if (!r.ok) toast.error(r.error);
      else toast.success('Recusado.');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não deu certo.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
            <ClipboardCheck className="h-6 w-6 text-primary" />
            Precisa de você
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Tudo que a Fluxia quer fazer e a sua política pede um humano. Aprove, edite ou recuse — cada decisão fica registrada.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Atualizar
        </Button>
      </header>

      {metrics ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          <Metric label="Aguardando" value={metrics.pending} accent={metrics.pending > 0} />
          <Metric label={`Automáticas (${metrics.days}d)`} value={metrics.autoExecuted} />
          <Metric label="Aprovadas" value={metrics.approved} />
          <Metric label="Recusadas" value={metrics.rejected} />
          <Metric label="Bloqueadas" value={metrics.blocked} />
          <Metric label="Taxa de aprovação" value={`${metrics.approvalRate}%`} hint={`${metrics.autoShare}% da rotina foi automática`} />
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-300">{error}</div>
      ) : null}

      {items === null && !error ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
        </div>
      ) : null}

      {items && items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <Check className="mx-auto mb-2 h-8 w-8 text-emerald-500" />
          <p className="font-medium text-foreground">Nada esperando por você</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Quando a IA precisar de aprovação (follow-up, proposta, desconto, fechar negócio…), aparece aqui. A política por ação fica em Agentes IA → Autonomia.
          </p>
        </div>
      ) : null}

      {items && items.length > 0 ? (
        <div className="flex flex-col gap-4">
          {items.map((it) => {
            const risk = RISK_META[it.risk];
            const chips = contextChips(it.payload);
            return (
              <div key={it.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        <Bot className="h-3 w-3" /> {it.actionLabel}
                      </span>
                      <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', risk.className)}>{risk.label}</span>
                      {it.humanOnly ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <ShieldAlert className="h-3 w-3" /> só humano executa
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <span className="inline-flex items-center gap-1 font-medium text-foreground">
                        <User className="h-3.5 w-3.5 text-muted-foreground" />
                        {it.contact.name || it.contact.phone || 'Contato'}
                      </span>
                      {it.deal ? (
                        <Link href={`/pipelines/${it.deal.id}`} className="inline-flex items-center gap-1 text-primary hover:underline">
                          {it.deal.title}
                          {money(it.deal.value) ? <span className="text-muted-foreground">· {money(it.deal.value)}</span> : null}
                          {it.deal.stageName ? <span className="text-muted-foreground">· {it.deal.stageName}</span> : null}
                        </Link>
                      ) : null}
                      {it.conversationId ? (
                        <Link href={`/inbox?c=${encodeURIComponent(it.conversationId)}`} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                          <MessageSquare className="h-3.5 w-3.5" /> conversa
                        </Link>
                      ) : null}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">{fmt(it.createdAt)}</div>
                </div>

                {it.reason ? <p className="mt-3 text-sm text-foreground">{it.reason}</p> : null}
                {chips.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {chips.map((c) => (
                      <span key={c} className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {c}
                      </span>
                    ))}
                  </div>
                ) : null}
                {it.policy ? <p className="mt-2 text-xs text-muted-foreground">Regra: {it.policy}</p> : null}

                {it.isMessage ? (
                  <div className="mt-3">
                    <Textarea
                      rows={3}
                      value={texts[it.id] ?? it.suggestedText ?? ''}
                      onChange={(e) => setTexts((t) => ({ ...t, [it.id]: e.target.value }))}
                      placeholder="Mensagem que será enviada ao cliente"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">Sugestão da IA — edite à vontade antes de aprovar.</p>
                  </div>
                ) : null}

                {it.error ? (
                  <div className="mt-3 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-600 dark:text-red-300">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Última tentativa falhou: {it.error}
                      {it.attempts > 0 ? ` (${it.attempts}x)` : ''}
                    </span>
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={() => void approve(it)} disabled={busy === it.id}>
                    {busy === it.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
                    {it.isMessage ? 'Aprovar e enviar' : 'Aprovar e executar'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void reject(it)} disabled={busy === it.id}>
                    <X className="mr-1 h-3.5 w-3.5" /> Recusar
                  </Button>
                  {it.deal && it.humanOnly ? (
                    <Link href={`/pipelines/${it.deal.id}`} className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                      abrir negócio <ExternalLink className="h-3 w-3" />
                    </Link>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <section className="rounded-xl border border-border bg-card">
        <button
          type="button"
          onClick={() => setShowAudit((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-foreground"
        >
          <span>Auditoria — o que a Fluxia fez sozinha, aprovou, recusou ou bloqueou (14 dias)</span>
          <span className="text-xs text-muted-foreground">{showAudit ? 'esconder' : `ver ${audit.length}`}</span>
        </button>
        {showAudit ? (
          <div className="border-t border-border">
            {audit.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">Nada registrado ainda.</p>
            ) : (
              <ul className="divide-y divide-border">
                {audit.map((a) => (
                  <li key={a.id} className="flex flex-col gap-1 px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{a.actionLabel}</span>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs',
                          a.status === 'sent' || a.status === 'done'
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : a.status === 'failed'
                              ? 'bg-red-500/15 text-red-700 dark:text-red-300'
                              : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {STATUS_LABEL[a.status] ?? a.status}
                        {a.status === 'sent' || a.status === 'done' ? (a.byHuman ? ' · humano aprovou' : ' · automático') : ''}
                      </span>
                      {a.contactName ? <span className="text-muted-foreground">{a.contactName}</span> : null}
                      <span className="ml-auto text-xs text-muted-foreground">{fmt(a.at)}</span>
                    </div>
                    {a.reason ? <p className="text-xs text-muted-foreground">Por quê: {a.reason}</p> : null}
                    {a.policy ? <p className="text-xs text-muted-foreground">Regra: {a.policy}</p> : null}
                    {a.error ? <p className="text-xs text-red-600 dark:text-red-300">Erro: {a.error}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Metric({ label, value, hint, accent }: { label: string; value: number | string; hint?: string; accent?: boolean }) {
  return (
    <div className={cn('rounded-lg border border-border bg-card p-3', accent && 'border-primary/40 bg-primary/5')}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-xl font-semibold tabular-nums', accent ? 'text-primary' : 'text-foreground')}>{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
