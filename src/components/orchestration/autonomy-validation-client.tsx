'use client';

// ============================================================
// 📊 Validação da autonomia — placar + tabela por ação + critério + auditoria
// com a cadeia sinal → política → decisão → ação → motivo → resultado.
// Cada número tem a definição ao lado: o dono decide olhando, não adivinhando.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ArrowLeft, Bot, ChevronDown, ChevronRight, ExternalLink, Loader2, MessageSquare, RefreshCw, ShieldCheck, Sliders, User } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  getAutonomyValidation,
  promoteAction,
  saveValidationCriteria,
  type ActionValidationRow,
  type AutonomyValidation,
  type Period,
  type ValidationAuditItem,
} from '@/app/(dashboard)/aprovacoes/validacao/actions';
import { ACTION_CATALOG, ORCH_ACTIONS, type Level, type OrchAction, type Risk } from '@/lib/orchestration/policy';
import { DEFAULT_CRITERIA, LEVEL_LABEL, VALIDATION_STATUS_META, type ValidationStatus } from '@/lib/orchestration/validation';

const PERIODS: { value: Period; label: string }[] = [
  { value: 7, label: 'Últimos 7 dias' },
  { value: 14, label: 'Últimos 14 dias' },
  { value: 30, label: 'Últimos 30 dias' },
  { value: 90, label: 'Últimos 90 dias' },
];

const RISK_META: Record<Risk, { label: string; className: string }> = {
  low: { label: 'risco baixo', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  medium: { label: 'risco médio', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  high: { label: 'risco alto', className: 'bg-orange-500/15 text-orange-700 dark:text-orange-300' },
  critical: { label: 'crítico', className: 'bg-red-500/15 text-red-700 dark:text-red-300' },
};

const TONE_CLASS: Record<(typeof VALIDATION_STATUS_META)[ValidationStatus]['tone'], string> = {
  muted: 'bg-muted text-muted-foreground',
  amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  emerald: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  primary: 'bg-primary/10 text-primary',
  red: 'bg-red-500/15 text-red-700 dark:text-red-300',
};

const STATUS_LABEL: Record<string, string> = {
  sent: 'enviada',
  done: 'feita',
  rejected: 'recusada',
  blocked: 'bloqueada',
  failed: 'falhou',
  expired: 'expirou',
  pending: 'aguardando',
};

const DECISION_LABEL: Record<string, string> = {
  auto: 'automática',
  approve: 'pediu aprovação',
  suggest: 'só sugestão',
  blocked: 'bloqueada pela política',
};

const SIGNAL_LABEL: Record<string, string> = {
  proposal_idle: 'Proposta sem resposta',
  followup_due: 'Follow-up vencido',
  stale_deal: 'Negócio parado',
  high_intent: 'Alta intenção de compra',
  churn_risk: 'Risco de perder o cliente',
  ticket_declining: 'Ticket caindo',
  customer_reactivated: 'Cliente voltou',
  approval_required: 'Aprovação pendente há tempo',
  repurchase_due: 'Hora da recompra',
  repurchase_overdue: 'Recompra atrasada',
  inactive: 'Cliente sumido',
  high_value: 'Cliente de alto valor',
  overdue_charges: 'Parcela vencida',
};

const FEEDBACK_LABEL: Record<string, string> = {
  approved: 'aprovou como veio',
  edited: 'editou o texto antes de enviar',
  rejected: 'recusou',
  reversed: 'desfez',
  bad_result: 'marcou como resultado ruim',
};

function fmt(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return String(iso);
  }
}

function fmtDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  } catch {
    return String(iso);
  }
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

function criteriaSentence(c: ActionValidationRow['criteria']): string {
  return `${c.minDecisions} decisões · ${c.minDays} dias de uso · ≥${pct(c.minCleanApprovalRate)} sem edição · ≤${pct(c.maxRejectionRate)} recusadas · ${c.maxBadOutcomes === 0 ? 'zero' : `até ${c.maxBadOutcomes}`} reversões`;
}

export function AutonomyValidationClient() {
  const [days, setDays] = useState<Period>(30);
  const [action, setAction] = useState<OrchAction | 'all'>('all');
  const [data, setData] = useState<AutonomyValidation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<OrchAction | null>(null);
  const [openAudit, setOpenAudit] = useState<string | null>(null);
  const [showCriteria, setShowCriteria] = useState(false);
  const [crit, setCrit] = useState({ minDecisions: '', minDays: '', minCleanPct: '', maxRejPct: '', maxBad: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getAutonomyValidation({ days, action });
      setData(d);
      setError(null);
      const o = d.override;
      setCrit({
        minDecisions: o?.minDecisions != null ? String(o.minDecisions) : '',
        minDays: o?.minDays != null ? String(o.minDays) : '',
        minCleanPct: o?.minCleanApprovalRate != null ? String(Math.round(o.minCleanApprovalRate * 100)) : '',
        maxRejPct: o?.maxRejectionRate != null ? String(Math.round(o.maxRejectionRate * 100)) : '',
        maxBad: o?.maxBadOutcomes != null ? String(o.maxBadOutcomes) : '',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível carregar a validação.');
    } finally {
      setLoading(false);
    }
  }, [days, action]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeLevel = async (row: ActionValidationRow, level: Level) => {
    if (level === 'auto') {
      const ok = window.confirm(
        `Liberar "${row.label}" para rodar SOZINHA?\n\nEla passa a executar dentro dos tetos e do horário, sem passar pela fila. Você pode voltar para "pede aprovação" a qualquer momento, e reversões continuam contando.`,
      );
      if (!ok) return;
    }
    setBusy(row.action);
    try {
      const r = await promoteAction(row.action, level);
      if (!r.ok) toast.error(r.error);
      else toast.success(`${row.label}: agora "${LEVEL_LABEL[level].toLowerCase()}".`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não deu certo.');
    } finally {
      setBusy(null);
    }
  };

  const saveCriteria = async (reset = false) => {
    setBusy('criteria');
    try {
      const toFrac = (s: string) => (s.trim() === '' ? undefined : Number(s.replace(',', '.')) / 100);
      const toInt = (s: string) => (s.trim() === '' ? undefined : Number(s));
      const r = await saveValidationCriteria(
        reset
          ? null
          : {
              minDecisions: toInt(crit.minDecisions),
              minDays: toInt(crit.minDays),
              minCleanApprovalRate: toFrac(crit.minCleanPct),
              maxRejectionRate: toFrac(crit.maxRejPct),
              maxBadOutcomes: toInt(crit.maxBad),
            },
      );
      if (!r.ok) toast.error(r.error);
      else toast.success(reset ? 'Critério voltou ao padrão.' : 'Critério salvo. As linhas abaixo já usam o novo.');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não deu certo.');
    } finally {
      setBusy(null);
    }
  };

  const cards = data?.cards;
  const actionLabel = action === 'all' ? 'todas as ações' : ACTION_CATALOG[action].label.toLowerCase();

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/aprovacoes" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3 w-3" /> Precisa de você
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold text-foreground">
            <ShieldCheck className="h-6 w-6 text-primary" />
            Validação da autonomia
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A IA só ganha o direito de agir sozinha por evidência. Aqui está o placar: o que ela executou, o que precisou de você, o que foi corrigido e quanto falta,
            por ação, para liberar o automático.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={String(days)} onValueChange={(v) => setDays((Number(v ?? 30) || 30) as Period)}>
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue>{PERIODS.find((p) => p.value === days)?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((p) => (
                <SelectItem key={p.value} value={String(p.value)}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={action} onValueChange={(v) => setAction((String(v ?? 'all') as OrchAction | 'all') || 'all')}>
            <SelectTrigger className="h-8 w-52 text-xs">
              <SelectValue>{action === 'all' ? 'Todas as ações' : ACTION_CATALOG[action].label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as ações</SelectItem>
              {ORCH_ACTIONS.map((a) => (
                <SelectItem key={a} value={a}>
                  {ACTION_CATALOG[a].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} /> Atualizar
          </Button>
        </div>
      </header>

      {error ? <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-300">{error}</div> : null}

      {data && !data.hasDefaultAgent ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-800 dark:text-amber-200">
          Esta conta ainda não tem um agente padrão. A política e o critério de autonomia moram nele — crie um em Agentes IA para liberar ações e ajustar o critério.
        </div>
      ) : null}

      {/* ---- Placar do período */}
      {cards ? (
        <section>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Placar · {PERIODS.find((p) => p.value === days)?.label.toLowerCase()} · {actionLabel}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Card label="Execuções" value={cards.executions} hint={`${cards.autoExecutions} automáticas · ${cards.approvedExecutions} aprovadas por você`} />
            <Card
              label="Sem intervenção humana"
              value={cards.autoShare == null ? '—' : `${cards.autoShare}%`}
              hint={cards.autoShare == null ? 'nenhuma execução no período' : `${cards.autoExecutions} de ${cards.executions} execuções rodaram sozinhas`}
              accent={cards.autoShare != null && cards.autoShare > 0}
            />
            <Card
              label="Correções"
              value={cards.edited + cards.corrected}
              hint={`${cards.edited} texto editado antes de enviar · ${cards.corrected} corrigida depois (IA pausada na conversa)`}
              warn={cards.edited + cards.corrected > 0}
            />
            <Card label="Reversões" value={cards.reversed} hint="desfeitas ou marcadas como resultado ruim" warn={cards.reversed > 0} />
            <Card
              label="Escaladas para você"
              value={cards.escalated}
              hint={`a política pediu um humano · ${cards.pendingNow} esperando agora${cards.blocked ? ` · ${cards.blocked} bloqueadas` : ''}`}
            />
            <Card
              label="Taxa de confiança"
              value={cards.confidence == null ? '—' : `${cards.confidence}%`}
              hint={
                cards.humanDecisions === 0
                  ? 'sem decisão humana no período'
                  : `${cards.cleanApprovals} aprovadas sem editar em ${cards.humanDecisions} decisões (${cards.rejected} recusadas)`
              }
              accent={cards.confidence != null && cards.confidence >= 85}
            />
          </div>
        </section>
      ) : loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
        </div>
      ) : null}

      {/* ---- Por ação */}
      {data ? (
        <section className="rounded-xl border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Por ação — quanto falta para rodar sozinha</h2>
              <p className="text-xs text-muted-foreground">Histórico completo da conta (o portão é cumulativo). Clique numa linha para ver o que falta e o critério usado.</p>
            </div>
            {data.canManage ? (
              <Button variant="outline" size="sm" onClick={() => setShowCriteria((v) => !v)}>
                <Sliders className="mr-1.5 h-3.5 w-3.5" /> {showCriteria ? 'Esconder critério' : 'Ajustar critério'}
              </Button>
            ) : null}
          </div>

          {showCriteria && data.canManage ? (
            <div className="border-b border-border bg-muted/30 px-4 py-4">
              <p className="text-sm font-medium text-foreground">Critério da conta para liberar o automático</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Vazio = padrão por tipo de ação (mensagem: {DEFAULT_CRITERIA.message.minDecisions} decisões em {DEFAULT_CRITERIA.message.minDays} dias, ≥
                {pct(DEFAULT_CRITERIA.message.minCleanApprovalRate)} sem edição · CRM: {DEFAULT_CRITERIA.crm.minDecisions} em {DEFAULT_CRITERIA.crm.minDays} dias · cobrança:
                20 em 14 dias, ≥90%). O critério tem que caber no seu volume real: grande demais é o mesmo que não ter. Cobrança e dinheiro nunca toleram reversão,
                mesmo que você configure.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-5">
                <Field label="Decisões mínimas" value={crit.minDecisions} onChange={(v) => setCrit((c) => ({ ...c, minDecisions: v }))} placeholder="20" />
                <Field label="Dias de uso mínimos" value={crit.minDays} onChange={(v) => setCrit((c) => ({ ...c, minDays: v }))} placeholder="14" />
                <Field label="Sem edição, mínimo (%)" value={crit.minCleanPct} onChange={(v) => setCrit((c) => ({ ...c, minCleanPct: v }))} placeholder="85" />
                <Field label="Recusadas, máximo (%)" value={crit.maxRejPct} onChange={(v) => setCrit((c) => ({ ...c, maxRejPct: v }))} placeholder="10" />
                <Field label="Reversões toleradas" value={crit.maxBad} onChange={(v) => setCrit((c) => ({ ...c, maxBad: v }))} placeholder="0" />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void saveCriteria(false)} disabled={busy === 'criteria'}>
                  {busy === 'criteria' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null} Salvar critério
                </Button>
                <Button size="sm" variant="outline" onClick={() => void saveCriteria(true)} disabled={busy === 'criteria' || !data.override}>
                  Voltar ao padrão
                </Button>
              </div>
            </div>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Ação</th>
                  <th className="px-2 py-2 font-medium">Nível hoje</th>
                  <th className="px-2 py-2 text-right font-medium">Decisões</th>
                  <th className="px-2 py-2 text-right font-medium">Sem edição</th>
                  <th className="px-2 py-2 text-right font-medium">Recusadas</th>
                  <th className="px-2 py-2 text-right font-medium">Reversões</th>
                  <th className="px-2 py-2 font-medium">Progresso</th>
                  <th className="px-2 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {data.actions.map((row) => {
                  const st = VALIDATION_STATUS_META[row.status];
                  const s = row.verdict.stats;
                  const clean = s.decisions ? s.cleanApprovals / s.decisions : null;
                  const rej = s.decisions ? s.rejected / s.decisions : null;
                  const open = openRow === row.action;
                  const firstBlocker = row.verdict.blockers[0]?.label;
                  return (
                    <RowGroup key={row.action}>
                      <tr className={cn('cursor-pointer border-b border-border/60 transition-colors hover:bg-muted/40', open && 'bg-muted/30')} onClick={() => setOpenRow(open ? null : row.action)}>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                            <span className="font-medium text-foreground">{row.label}</span>
                            <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', RISK_META[row.risk].className)}>{RISK_META[row.risk].label}</span>
                          </div>
                        </td>
                        <td className="px-2 py-2.5 text-xs text-muted-foreground">{row.humanOnly ? 'Só humano' : LEVEL_LABEL[row.level]}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums">
                          {s.decisions}
                          {row.firstDecisionAt ? <span className="ml-1 text-[11px] text-muted-foreground">desde {fmtDay(row.firstDecisionAt)}</span> : null}
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums">{clean == null ? '—' : pct(clean)}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums">{rej == null ? '—' : pct(rej)}</td>
                        <td className={cn('px-2 py-2.5 text-right tabular-nums', s.badOutcomes > 0 && 'font-semibold text-red-600 dark:text-red-300')}>{s.badOutcomes}</td>
                        <td className="px-2 py-2.5">
                          {row.humanOnly ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            <div className="flex items-center gap-2">
                              <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                                <div
                                  className={cn('h-full rounded-full', row.status === 'eligible' || row.status === 'auto' ? 'bg-emerald-500' : row.verdict.progress >= 0.6 ? 'bg-primary' : 'bg-amber-500')}
                                  style={{ width: `${Math.round(Math.max(row.status === 'auto' ? 1 : 0, row.verdict.progress) * 100)}%` }}
                                />
                              </div>
                              <span className="text-[11px] tabular-nums text-muted-foreground">{Math.round((row.status === 'auto' ? 1 : row.verdict.progress) * 100)}%</span>
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2.5">
                          <span className={cn('inline-block rounded-full px-2 py-0.5 text-xs font-medium', TONE_CLASS[st.tone])} title={st.hint}>
                            {st.label}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                          {data.canManage && !row.humanOnly ? (
                            row.status === 'auto' ? (
                              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy === row.action} onClick={() => void changeLevel(row, 'approve')}>
                                Voltar para aprovação
                              </Button>
                            ) : row.status === 'suggest_only' ? (
                              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy === row.action} onClick={() => void changeLevel(row, 'approve')}>
                                Começar a validar
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                className="h-7 text-xs"
                                disabled={busy === row.action || row.status !== 'eligible'}
                                title={row.status !== 'eligible' ? firstBlocker : undefined}
                                onClick={() => void changeLevel(row, 'auto')}
                              >
                                {busy === row.action ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null} Liberar automático
                              </Button>
                            )
                          ) : null}
                        </td>
                      </tr>
                      {open ? (
                        <tr className="border-b border-border/60 bg-muted/20">
                          <td colSpan={9} className="px-4 py-3">
                            <div className="grid gap-3 text-xs sm:grid-cols-2">
                              <div>
                                <p className="font-medium text-foreground">{st.label}: {st.hint}</p>
                                <p className="mt-1 text-muted-foreground">{row.hint}</p>
                                {row.verdict.blockers.length && !row.humanOnly && row.status !== 'auto' ? (
                                  <ul className="mt-2 space-y-1">
                                    {row.verdict.blockers.map((b) => (
                                      <li key={b.code} className="flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
                                        <span aria-hidden="true">•</span>
                                        <span>{b.label}</span>
                                      </li>
                                    ))}
                                  </ul>
                                ) : null}
                              </div>
                              <div className="space-y-1 text-muted-foreground">
                                <p>
                                  <span className="font-medium text-foreground">Critério:</span> {criteriaSentence(row.criteria)}
                                </p>
                                <p>
                                  <span className="font-medium text-foreground">Histórico:</span> {s.decisions} decisões ({s.cleanApprovals} sem edição · {s.edited} editadas · {s.rejected} recusadas) ·{' '}
                                  {s.badOutcomes} reversões · {s.spanDays} dias de uso
                                  {row.lastDecisionAt ? ` · última em ${fmtDay(row.lastDecisionAt)}` : ''}
                                </p>
                                <p>
                                  <span className="font-medium text-foreground">Execuções:</span> {row.executedAll} no total ({row.autoAll} automáticas) · {row.executedPeriod} no período ·{' '}
                                  {row.pending} esperando você
                                  {row.badOutcomesAll ? ` · ${row.badOutcomesAll} corrigidas/revertidas` : ''}
                                </p>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </RowGroup>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ---- Auditoria com a cadeia completa */}
      {data ? (
        <section className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground">Auditoria — sinal → política → decisão → ação → motivo → resultado</h2>
            <p className="text-xs text-muted-foreground">
              {data.audit.length === 0 ? 'Nada registrado no período.' : `${data.audit.length} ações no período (as mais recentes; clique para abrir a cadeia).`}
            </p>
          </div>
          {data.audit.length ? (
            <ul className="divide-y divide-border">
              {data.audit.map((a) => (
                <AuditRow key={a.id} item={a} open={openAudit === a.id} onToggle={() => setOpenAudit(openAudit === a.id ? null : a.id)} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function RowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function Card({ label, value, hint, accent, warn }: { label: string; value: number | string; hint?: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className={cn('rounded-lg border border-border bg-card p-3', accent && 'border-primary/40 bg-primary/5', warn && 'border-amber-500/40 bg-amber-500/5')}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-xl font-semibold tabular-nums', accent ? 'text-primary' : warn ? 'text-amber-700 dark:text-amber-300' : 'text-foreground')}>{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Input inputMode="decimal" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="h-8 text-sm" />
    </label>
  );
}

function AuditRow({ item: a, open, onToggle }: { item: ValidationAuditItem; open: boolean; onToggle: () => void }) {
  const executada = a.status === 'sent' || a.status === 'done';
  return (
    <li>
      <button type="button" onClick={onToggle} className="flex w-full flex-col gap-1 px-4 py-3 text-left text-sm hover:bg-muted/40">
        <div className="flex flex-wrap items-center gap-2">
          {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <Bot className="h-3.5 w-3.5 text-primary" /> {a.actionLabel}
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs',
              executada ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : a.status === 'failed' ? 'bg-red-500/15 text-red-700 dark:text-red-300' : 'bg-muted text-muted-foreground',
            )}
          >
            {STATUS_LABEL[a.status] ?? a.status}
            {executada ? (a.byHuman ? ' · humano aprovou' : ' · automática') : ''}
          </span>
          {a.outcome ? (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
              {a.outcome === 'reverted' ? 'desfeita' : a.outcome === 'corrected' ? 'corrigida' : 'resultado ruim'}
            </span>
          ) : null}
          {a.contactName ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <User className="h-3 w-3" /> {a.contactName}
            </span>
          ) : null}
          <span className="ml-auto text-xs text-muted-foreground">{fmt(a.resolvedAt ?? a.createdAt)}</span>
        </div>
        {!open && a.reason ? <p className="pl-5 text-xs text-muted-foreground">Por quê: {a.reason}</p> : null}
      </button>
      {open ? (
        <div className="grid gap-2 border-t border-border/60 bg-muted/20 px-4 py-3 text-xs sm:grid-cols-2">
          <Step n={1} title="Sinal">
            {a.signalType ? (SIGNAL_LABEL[a.signalType] ?? a.signalType) : 'sem sinal registrado'}
            {a.severity != null ? ` · prioridade ${a.severity}` : ''}
            {a.chips.length ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {a.chips.map((c) => (
                  <span key={c} className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {c}
                  </span>
                ))}
              </div>
            ) : null}
          </Step>
          <Step n={2} title="Política">{a.policy ?? '—'}</Step>
          <Step n={3} title="Decisão">
            {a.decision ? (DECISION_LABEL[a.decision] ?? a.decision) : '—'}
            {a.byHuman ? ` · ${a.resolvedByName ? `${a.resolvedByName} decidiu` : 'humano decidiu'} em ${fmt(a.resolvedAt)}` : a.executedAt ? ` · executada em ${fmt(a.executedAt)}` : ''}
            {a.status === 'rejected' ? ' · recusada' : a.status === 'expired' ? ' · expirou antes de alguém decidir' : ''}
          </Step>
          <Step n={4} title="Ação">
            {a.actionLabel}
            {a.suggestedText ? <p className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-background p-2 text-foreground/90">{a.suggestedText}</p> : null}
            <div className="mt-1 flex flex-wrap gap-3">
              {a.conversationId ? (
                <Link href={`/inbox?c=${encodeURIComponent(a.conversationId)}`} className="inline-flex items-center gap-1 text-primary hover:underline">
                  <MessageSquare className="h-3 w-3" /> conversa
                </Link>
              ) : null}
              {a.dealId ? (
                <Link href={`/pipelines/${a.dealId}`} className="inline-flex items-center gap-1 text-primary hover:underline">
                  <ExternalLink className="h-3 w-3" /> {a.dealTitle ?? 'negócio'}
                </Link>
              ) : null}
            </div>
          </Step>
          <Step n={5} title="Motivo">{a.reason ?? '—'}</Step>
          <Step n={6} title="Resultado">
            {a.error ? <span className="text-red-600 dark:text-red-300">Erro: {a.error}</span> : null}
            {a.outcome ? (
              <p>
                {a.outcome === 'reverted' ? 'Desfeita' : a.outcome === 'corrected' ? 'Corrigida (IA pausada na conversa)' : 'Marcada como resultado ruim'}
                {a.revertedAt ? ` em ${fmt(a.revertedAt)}` : ''}
                {a.outcomeReason ? ` — "${a.outcomeReason}"` : ''}
              </p>
            ) : null}
            {a.feedback.length ? (
              <ul className="mt-1 space-y-0.5">
                {a.feedback.map((f, i) => (
                  <li key={i} className="text-muted-foreground">
                    {fmt(f.at)}: {FEEDBACK_LABEL[f.decision] ?? f.decision}
                    {f.reasonText ? ` — "${f.reasonText}"` : f.reasonCode ? ` (${f.reasonCode})` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            {!a.error && !a.outcome && !a.feedback.length ? (executada ? 'Sem correção até agora.' : '—') : null}
          </Step>
        </div>
      ) : null}
    </li>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">{n}</span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{title}</p>
        <div className="text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}
