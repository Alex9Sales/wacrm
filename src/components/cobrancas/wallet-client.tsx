'use client';

// ============================================================
// 🧾 Carteira vencida (tela /cobrancas) — agente de cobrança, Fase 1.
//
// Esta fase NÃO envia nada. A tela existe para o cliente abrir, reconhecer as
// cobranças dele e conferir valor e conta antes de qualquer mensagem existir.
// Por isso o aviso no topo é permanente, e não um toast que some.
//
// A carteira aparece agrupada por DEVEDOR (não por cobrança), que é exatamente
// como a Fase 2 vai cobrar: uma mensagem por pessoa, com as parcelas juntas.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  Check,
  ChevronDown,
  ExternalLink,
  Eye,
  Link2,
  Link2Off,
  Loader2,
  Phone,
  Plus,
  Receipt,
  RefreshCw,
  BellOff,
  Bot,
  Copy,
  Play,
  ShieldCheck,
  Search,
  Settings2,
  Trash2,
  TriangleAlert,
  User,
  UserPlus,
  Users,
} from 'lucide-react';
import { isStaleActionError, reloadForStaleAction } from '@/lib/stale-action';

import { Button } from '@/components/ui/button';
import { ContactPicker } from '@/components/contacts/contact-picker';
import { parseDueDate, parseValue } from '@/lib/collections/emit-rules';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import {
  getCollectionsPromotion,
  getCollectionsSettings,
  getWallet,
  checkAsaasDuplicates,
  createChargeManual,
  createContactForDebtor,
  createContactsForPendingDebtors,
  linkDebtorToContact,
  listCollectionAssignees,
  listCollectionChannels,
  listCollectionSectors,
  type CollectionAssigneeOption,
  type CollectionChannelOption,
  type CollectionSectorOption,
  listConnections,
  removeConnection,
  adoptAsaasPhone,
  restoreContactPhone,
  saveConnection,
  searchContactsForCharge,
  runCollectionsNow,
  saveCollectionsSettings,
  setAsaasNotifications,
  setCollectionsAutonomy,
  setDebtorPaused,
  syncNow,
  unlinkDebtor,
  type ConnectionView,
  type ContactOption,
  type PromotionView,
  type WalletDebtor,
  type WalletSummary,
  changeChargeDueDate,
  clearPaymentPromise,
  registerPaymentPromise,
} from '@/app/(dashboard)/cobrancas/actions';
import { CHARGEABLE_STATUSES, WEEKDAY_SHORT, describeWeekdays, type CollectionsSettings } from '@/lib/collections/rules';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** "5512997075373" → "(12) 99707-5373". O que não for número BR sai como veio. */
function fmtPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  const local = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d;
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  return raw;
}

function lateLabel(days: number | null): { text: string; tone: string } {
  if (days == null) return { text: 'sem vencimento', tone: 'text-muted-foreground' };
  if (days < 0) return { text: `vence em ${Math.abs(days)}d`, tone: 'text-muted-foreground' };
  if (days === 0) return { text: 'vence hoje', tone: 'text-amber-600 dark:text-amber-500' };
  if (days <= 7) return { text: `${days}d de atraso`, tone: 'text-amber-600 dark:text-amber-500' };
  if (days <= 30) return { text: `${days}d de atraso`, tone: 'text-orange-600 dark:text-orange-500' };
  return { text: `${days}d de atraso`, tone: 'text-red-600 dark:text-red-500' };
}

export function WalletClient() {
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [conns, setConns] = useState<ConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [linkFor, setLinkFor] = useState<WalletDebtor | null>(null);
  const [pauseFor, setPauseFor] = useState<WalletDebtor | null>(null);
  const [onlyPending, setOnlyPending] = useState(false);
  // Filtro "Promessas": quem prometeu pagar (a régua dorme até a data).
  const [onlyPromises, setOnlyPromises] = useState(false);
  const [promiseFor, setPromiseFor] = useState<WalletDebtor | null>(null);
  const [rule, setRule] = useState<CollectionsSettings | null>(null);
  const [running, setRunning] = useState(false);
  const [upcoming, setUpcoming] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [newChargeOpen, setNewChargeOpen] = useState(false);
  const [promo, setPromo] = useState<PromotionView | null>(null);

  const load = useCallback(async () => {
    try {
      const [w, c, r, p] = await Promise.all([
        getWallet(),
        listConnections(),
        getCollectionsSettings(),
        getCollectionsPromotion(),
      ]);
      setWallet(w);
      setConns(c);
      setRule(r);
      setPromo(p);
    } catch {
      toast.error('Não foi possível carregar a carteira.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await syncNow();
      if (!res.ok) {
        toast.error(res.error ?? 'Não foi possível sincronizar.');
      } else {
        const d = res.data!;
        setUpcoming(d.upcoming);
        toast.success(
          `${d.total} ${d.total === 1 ? 'cobrança vencida' : 'cobranças vencidas'} na carteira` +
            (d.pending ? ` · ${d.pending} sem contato` : '') +
            (d.closed ? ` · ${d.closed} saíram desde a última vez` : '') +
            (!d.total && d.upcoming ? ` · ${d.upcoming} ainda a vencer` : ''),
        );
      }
      await load();
    } catch {
      toast.error('Não foi possível sincronizar.');
    } finally {
      setSyncing(false);
    }
  }

  // Filtro por conta do Asaas (09/09, João/GoLink ligou duas contas e a
  // carteira somava tudo junto): clicar no nome da conta mostra só ela;
  // nenhuma selecionada = todas. Só visual — a régua continua cobrando as
  // parcelas de todas as contas na mesma mensagem.
  const [connFilter, setConnFilter] = useState<string | null>(null);
  const connFilterLabel = connFilter ? conns.find((c) => c.id === connFilter)?.label ?? null : null;

  const debtors = useMemo(() => {
    let all = wallet?.debtors ?? [];
    if (connFilter) {
      all = all
        .map((d) => {
          const charges = d.charges.filter((c) => c.connectionId === connFilter);
          if (!charges.length) return null;
          const next: WalletDebtor = {
            ...d,
            charges,
            total: charges.reduce((s, c) => s + (Number(c.value) || 0), 0),
            oldestDaysLate: Math.max(...charges.map((c) => c.daysLate ?? 0)),
          };
          return next;
        })
        .filter((d): d is WalletDebtor => d !== null);
    }
    if (onlyPromises) all = all.filter((d) => hasPromise(d));
    return onlyPending ? all.filter((d) => !d.contactId) : all;
  }, [wallet, onlyPending, onlyPromises, connFilter]);

  const promisesCount = useMemo(() => (wallet?.debtors ?? []).filter((d) => hasPromise(d)).length, [wallet]);

  // Números do topo acompanham o filtro (sem filtro = os da carteira inteira).
  const totals = useMemo(() => {
    if (!connFilter) {
      return { debtors: wallet?.debtors.length ?? 0, charges: wallet?.totalCharges ?? 0, value: wallet?.totalValue ?? 0 };
    }
    const base = (wallet?.debtors ?? []).flatMap((d) =>
      d.charges.filter((c) => c.connectionId === connFilter).map((c) => ({ key: d.key, value: Number(c.value) || 0 })),
    );
    return { debtors: new Set(base.map((b) => b.key)).size, charges: base.length, value: base.reduce((s, b) => s + b.value, 0) };
  }, [wallet, connFilter]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Carregando a carteira…
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Carteira vencida</h1>
          <p className="text-sm text-muted-foreground">
            O que está em aberto no Asaas, e a régua que cobra isso.
          </p>
        </div>
        <div className="flex gap-2">
          {!!conns.length && (
            <Button variant="outline" onClick={() => setNewChargeOpen(true)} title="Gerar uma cobrança no Asaas para um contato e, se quiser, mandar o link na conversa">
              <Receipt className="mr-1.5 h-4 w-4" /> Nova cobrança
            </Button>
          )}
          <Button variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> Conectar Asaas
          </Button>
          <Button onClick={handleSync} disabled={syncing || !conns.length}>
            {syncing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
            Atualizar
          </Button>
        </div>
      </header>

      {/* Aviso permanente. Não é toast — é contrato com quem opera. */}
      {rule && !rule.enabled ? (
        <div className="flex items-start gap-2.5 rounded-md border border-border bg-muted/40 px-3.5 py-2.5 text-sm text-foreground">
          <Eye className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p>
            <strong>Régua desligada.</strong> Nada é montado nem enviado — o que estiver em{' '}
            <a href="/aprovacoes" className="font-medium underline underline-offset-2">Precisa de você</a> fica parado, e rascunho de
            outro dia é descartado (a régua refaz com os números do dia).{' '}
            {rule.autoSend
              ? `Ao ligar, as cobranças saem sozinhas, uma a cada ${rule.sendEveryMinutes} min, das ${rule.startHour}h às ${rule.endHour}h, ${describeWeekdays(rule.sendWeekdays)}${rule.skipHolidays ? ' (feriado nacional não)' : ''} — não precisa aprovar nada.`
              : 'Ao ligar, a régua monta as mensagens e deixa em Precisa de você para você aprovar.'}
          </p>
        </div>
      ) : rule?.enabled && rule.autoSend ? (
        <div className="flex items-start gap-2.5 rounded-md border border-amber-500/40 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <Bot className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <strong>Envio automático ligado.</strong> As cobranças saem sozinhas, uma a cada {rule.sendEveryMinutes} min, das {rule.startHour}h às{' '}
            {rule.endHour}h, {describeWeekdays(rule.sendWeekdays)}{rule.skipHolidays ? ' (feriado nacional não)' : ''}, sem passar por Precisa de você. Antes de cada envio o sistema confere de
            novo se a parcela continua em aberto. Para voltar a aprovar uma a uma, desmarque &quot;Enviar sozinha&quot; em Ajustar.
          </p>
        </div>
      ) : (
        <div className="flex items-start gap-2.5 rounded-md border border-emerald-600/30 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          <Eye className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <strong>Nenhuma cobrança sai sem você aprovar.</strong> A régua monta as mensagens e deixa em{' '}
            <a href="/aprovacoes" className="font-medium underline underline-offset-2">Precisa de você</a>, onde dá para ler,
            editar e mandar — ou recusar (também dá para aprovar todas de uma vez: saem uma a cada {rule?.sendEveryMinutes ?? 5} min). Antes de
            cada envio o sistema confere de novo se a parcela continua em aberto.
          </p>
        </div>
      )}

      <ConnectionsPanel
        conns={conns}
        onChanged={load}
        onSync={(id) => void handleSyncOne(id)}
        filter={connFilter}
        onFilter={(id) => setConnFilter((cur) => (cur === id ? null : id))}
      />

      {!!conns.length && rule && (
        <RulePanel
          rule={rule}
          running={running}
          onSaved={(r) => setRule(r)}
          onRun={async () => {
            setRunning(true);
            try {
              const res = await runCollectionsNow();
              if (!res.ok) toast.error(res.error ?? 'A régua não rodou.');
              else if (!res.data!.queued) toast.info('Nenhum devedor elegível agora — ninguém venceu o intervalo ou o prazo mínimo.');
              else toast.success(`${res.data!.queued} ${res.data!.queued === 1 ? 'cobrança foi' : 'cobranças foram'} para "Precisa de você".`);
              await load();
            } finally {
              setRunning(false);
            }
          }}
        />
      )}

      {!!conns.length && rule?.enabled && promo && <PromotionPanel promo={promo} onChanged={load} />}

      {!conns.length ? (
        <EmptyState onAdd={() => setAddOpen(true)} />
      ) : (
        <>
          {connFilterLabel && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Mostrando só a conta</span>
              <button
                type="button"
                onClick={() => setConnFilter(null)}
                className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 font-medium text-primary hover:bg-primary/15"
                title="Voltar a ver todas as contas"
              >
                <Building2 className="h-3.5 w-3.5" /> {connFilterLabel} <span aria-hidden>×</span>
              </button>
              <span className="text-xs text-muted-foreground">(clique no nome de outra conta para trocar; nenhuma selecionada = todas)</span>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="Clientes em atraso" value={String(totals.debtors)} hint="um por pessoa, com todas as parcelas dele" />
            <Stat label="Parcelas vencidas" value={String(totals.charges)} hint="a vencer não entra aqui — só o lembrete" />
            <Stat label={connFilterLabel ? `Em aberto · ${connFilterLabel}` : 'Total em aberto'} value={brl(totals.value)} wide />
            <Stat
              label={`Recuperado (${wallet?.recovered.days ?? 30} dias)`}
              value={brl(wallet?.recovered.afterTouchTotal ?? 0)}
              hint={
                wallet && wallet.recovered.paidCount > 0
                  ? `${wallet.recovered.afterTouchCount} de ${wallet.recovered.paidCount} pagas depois de uma mensagem da régua · ${brl(wallet.recovered.paidTotal)} pagas no total`
                  : 'pagas depois de uma mensagem da régua'
              }
              tone={wallet?.recovered.afterTouchTotal ? 'good' : undefined}
              wide
            />
            <Stat
              label="Sem contato"
              value={String(wallet?.pendingMatch ?? 0)}
              tone={wallet?.pendingMatch ? 'warn' : undefined}
            />
          </div>

          {!!wallet?.pendingMatch && (
            <div className="flex items-start gap-2.5 rounded-md border border-amber-500/40 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                {wallet.pendingMatch === 1
                  ? '1 devedor não casou com nenhum contato do CRM'
                  : `${wallet.pendingMatch} devedores não casaram com nenhum contato do CRM`}
                . Preferimos deixar pendente a arriscar cobrar a pessoa errada — ligue no contato certo abaixo.{' '}
                <button
                  type="button"
                  className="font-medium underline underline-offset-2"
                  onClick={() => setOnlyPending((v) => !v)}
                >
                  {onlyPending ? 'ver todos' : 'ver só as pendências'}
                </button>
              </p>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto shrink-0"
                disabled={bulkBusy}
                title="Cria um contato novo para cada pendência com telefone, com nome/telefone/e-mail do Asaas, e liga as cobranças"
                onClick={async () => {
                  setBulkBusy(true);
                  try {
                    const res = await createContactsForPendingDebtors();
                    if (!res.ok) {
                      toast.error(res.error ?? 'Não foi possível criar os contatos.');
                      return;
                    }
                    const d = res.data!;
                    const parts = [
                      d.created ? `${d.created} ${d.created === 1 ? 'contato criado' : 'contatos criados'}` : '',
                      d.linked ? `${d.linked} ${d.linked === 1 ? 'já existia e foi ligado' : 'já existiam e foram ligados'}` : '',
                    ].filter(Boolean);
                    if (parts.length) toast.success(parts.join(' · ') + '.');
                    if (d.skipped.length) {
                      toast.warning(
                        `${d.skipped.length} ${d.skipped.length === 1 ? 'ficou pendente' : 'ficaram pendentes'}: ${d.skipped
                          .slice(0, 3)
                          .map((x) => `${x.name} (${x.reason})`)
                          .join('; ')}${d.skipped.length > 3 ? '…' : ''}`,
                        { duration: 10000 },
                      );
                    }
                    await load();
                  } finally {
                    setBulkBusy(false);
                  }
                }}
              >
                {bulkBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <UserPlus className="mr-1.5 h-3.5 w-3.5" />}
                Criar contatos do Asaas
              </Button>
            </div>
          )}

          {promisesCount > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <button
                type="button"
                onClick={() => setOnlyPromises((v) => !v)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-medium',
                  onlyPromises ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground hover:text-foreground',
                )}
                title="Quem prometeu pagar — a régua dorme até a data combinada"
              >
                <CalendarClock className="h-3.5 w-3.5" /> Promessas de pagamento ({promisesCount}){onlyPromises ? ' ×' : ''}
              </button>
              {onlyPromises && <span className="text-xs text-muted-foreground">Mostrando só quem prometeu. Em cada um dá para mudar a data ou cobrar agora.</span>}
            </div>
          )}
          <div className="flex flex-col gap-2.5">
            {debtors.map((d) => (
              <DebtorCard
                key={d.key}
                debtor={d}
                onLink={() => setLinkFor(d)}
                onUnlink={load}
                onPause={() => setPauseFor(d)}
                onPromise={() => setPromiseFor(d)}
                onChanged={load}
              />
            ))}
            {!debtors.length && (
              <div className="rounded-md border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">
                {onlyPending ? (
                  'Nenhuma pendência de contato — todos os devedores casaram.'
                ) : upcoming ? (
                  <>
                    <p className="font-medium text-foreground">Nenhuma cobrança vencida.</p>
                    <p className="mx-auto mt-1 max-w-lg">
                      Você tem {upcoming} {upcoming === 1 ? 'cobrança' : 'cobranças'} no Asaas, mas {upcoming === 1 ? 'ela ainda não venceu' : 'nenhuma venceu ainda'}. Esta
                      tela mostra só o que passou do vencimento. Se você quer avisar <em>antes</em> de vencer, marque
                      &ldquo;A vencer&rdquo; em Ajustar — mas aí é lembrete, não cobrança de inadimplente.
                    </p>
                  </>
                ) : (
                  'Nenhuma cobrança vencida. Toque em Atualizar para buscar no Asaas.'
                )}
              </div>
            )}
          </div>
        </>
      )}

      <AddConnectionDialog open={addOpen} onOpenChange={setAddOpen} onSaved={load} />
      <LinkContactDialog debtor={linkFor} onClose={() => setLinkFor(null)} onLinked={load} />
      {newChargeOpen && <NewChargeDialog conns={conns.filter((c) => c.enabled)} onClose={() => setNewChargeOpen(false)} onCreated={load} />}
      <PauseDebtorDialog debtor={pauseFor} onClose={() => setPauseFor(null)} onSaved={load} />
      <PromiseDialog debtor={promiseFor} onClose={() => setPromiseFor(null)} onSaved={load} />
    </div>
  );

  async function handleSyncOne(id: string) {
    setSyncing(true);
    try {
      const res = await syncNow(id);
      if (!res.ok) toast.error(res.error ?? 'Não foi possível sincronizar esta conta.');
      else toast.success(`${res.data!.total} em aberto nesta conta.`);
      await load();
    } finally {
      setSyncing(false);
    }
  }
}

function Stat({ label, value, tone, wide, hint }: { label: string; value: string; tone?: 'warn' | 'good'; wide?: boolean; hint?: string }) {
  return (
    <div className={cn('rounded-md border bg-card px-3.5 py-3', tone === 'good' && 'border-emerald-600/40')}>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-0.5 font-semibold tabular-nums',
          wide ? 'text-lg' : 'text-xl',
          tone === 'warn' && 'text-amber-600 dark:text-amber-500',
          tone === 'good' && 'text-emerald-700 dark:text-emerald-400',
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function DebtorCard({
  debtor,
  onLink,
  onUnlink,
  onPause,
  onPromise,
  onChanged,
}: {
  debtor: WalletDebtor;
  onLink: () => void;
  onUnlink: () => void;
  onPause: () => void;
  onPromise: () => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const late = lateLabel(debtor.oldestDaysLate);
  const promised = hasPromise(debtor);

  return (
    <div
      className={cn(
        'rounded-md border bg-card',
        !debtor.contactId && 'border-amber-500/40',
        debtor.paused && 'border-dashed opacity-75',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-3">
        <button type="button" className="flex-1 text-left" onClick={() => setOpen((v) => !v)}>
          <p className="font-medium">{debtor.name}</p>
          <p className="text-xs text-muted-foreground">
            {debtor.charges.length === 1 ? '1 cobrança' : `${debtor.charges.length} cobranças`} ·{' '}
            <span className={late.tone}>{late.text}</span>
            {debtor.phone ? ` · ${debtor.phone}` : ''}
          </p>
          <p className="text-xs text-muted-foreground">{reguaStatus(debtor)}</p>
        </button>

        {/* 📇 11/09 (João): quem recebe a cobrança é a ficha do CRM, mas a tela
            não dizia QUAL — ele ligou no contato errado e perguntou "como
            volto?". Agora o nome aparece e o link abre a ficha para editar. */}
        {debtor.contactId && (
          <a
            href={`/contacts?c=${debtor.contactId}`}
            className="inline-flex max-w-[14rem] items-center gap-1 truncate text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            title="Abrir a ficha do contato que recebe esta cobrança"
            onClick={(e) => e.stopPropagation()}
          >
            <User className="h-3 w-3 shrink-0" />
            <span className="truncate">
              vai para {debtor.contactName ?? 'contato sem nome'}
            </span>
          </a>
        )}

        <p className="font-semibold tabular-nums">{brl(debtor.total)}</p>

        {debtor.duplicateSuspect && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-800 dark:bg-red-950 dark:text-red-300"
            title="Parcela com o mesmo valor e vencimento em dois cadastros do Asaas. A régua não cobra até você resolver lá (apagar o cadastro repetido)."
          >
            <Users className="h-3 w-3" /> possível duplicado no Asaas
          </span>
        )}

        {/* 📞 11/09 (João/GoLink): trocar o celular no Asaas não mudava para
            onde a cobrança ia — o envio usa a ficha do contato. Em vez de
            sobrescrever sozinho (o que foi corrigido à mão aqui tem que valer),
            a carteira avisa e deixa a troca a um clique. */}
        {debtor.phoneDiffers && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <Phone className="h-3.5 w-3.5 shrink-0" />
            <span>
              No Asaas o telefone é <strong className="font-semibold">{fmtPhone(debtor.phoneDiffers.asaas)}</strong>
              {debtor.phoneDiffers.crm ? (
                <> e a cobrança está saindo para <strong className="font-semibold">{fmtPhone(debtor.phoneDiffers.crm)}</strong>.</>
              ) : (
                <> e este contato não tem telefone.</>
              )}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={async () => {
                const res = await adoptAsaasPhone(debtor.contactId!);
                if (!res.ok) {
                  // Número já é de outro contato: abre direto a troca de
                  // contato, em vez de deixar o aviso sem saída.
                  toast.error(res.error ?? 'Não foi possível trocar o telefone.');
                  if ((res.error ?? '').includes('Ligar a um contato')) onLink();
                  return;
                }
                const anterior = res.data!.previousPhone;
                toast.success(`Agora a cobrança de ${debtor.name} sai para ${fmtPhone(res.data!.phone)}.`, {
                  // Clicar no devedor errado aqui muda para onde a cobrança vai.
                  // Sem volta, o cliente fica sem saída (11/09, João).
                  duration: 12_000,
                  action: anterior
                    ? {
                        label: 'Desfazer',
                        onClick: async () => {
                          const back = await restoreContactPhone(debtor.contactId!, anterior);
                          if (!back.ok) toast.error(back.error ?? 'Não foi possível desfazer.');
                          else toast.success(`Voltou para ${fmtPhone(anterior)}.`);
                          onChanged();
                        },
                      }
                    : undefined,
                });
                onChanged();
              }}
            >
              Usar o do Asaas
            </Button>
          </div>
        )}
        {debtor.contactId ? (
          <div className="flex items-center gap-1.5">
            {debtor.paused && (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                <BellOff className="h-3 w-3" /> não cobrar
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              <Check className="h-3 w-3" />
              {debtor.matchedBy === 'manual' ? 'ligado na mão' : 'contato do CRM'}
            </span>
            {promised && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-300"
                title={debtor.snoozeReason ?? undefined}
              >
                <CalendarClock className="h-3 w-3" /> prometeu {new Date(debtor.snoozeUntil!).toLocaleDateString('pt-BR')}
              </span>
            )}
            {debtor.paused ? (
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  const res = await setDebtorPaused(debtor.contactId!, false, null);
                  if (!res.ok) toast.error(res.error ?? 'Não foi possível retomar.');
                  else toast.success(`A régua voltou a valer para ${debtor.name}.`);
                  onChanged();
                }}
              >
                Voltar a cobrar
              </Button>
            ) : (
              <>
                {promised ? (
                  <Button
                    size="sm"
                    variant="outline"
                    title="Tira a promessa: a régua volta a cobrar este devedor no próximo ciclo"
                    onClick={async () => {
                      if (!confirm(`Cobrar ${debtor.name} de novo? A promessa registrada é apagada e a régua volta a valer.`)) return;
                      const res = await clearPaymentPromise(debtor.contactId!);
                      if (!res.ok) toast.error(res.error ?? 'Não deu certo.');
                      else toast.success(`${debtor.name} volta pra régua.`);
                      onChanged();
                    }}
                  >
                    Cobrar agora
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={onPromise} title={promised ? 'Mudar a data prometida' : 'Cliente prometeu pagar em uma data — a régua dorme até lá'}>
                  <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
                <Button size="sm" variant="ghost" onClick={onPause} title="Nunca cobrar este devedor pela régua">
                  <BellOff className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
                {/* 11/09: trocar o contato ligado também precisa existir. O
                    devedor cujo número do Asaas já pertence a OUTRO contato
                    (Center Pisos × Center Raspadora) não tinha saída na tela:
                    "Usar o do Asaas" recusava e mandava religar, e o botão de
                    religar só aparecia para devedor SEM contato. */}
                <Button size="sm" variant="ghost" onClick={onLink} title="Trocar o contato do CRM que recebe esta cobrança">
                  <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </>
            )}
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={onLink}>
            <Link2 className="mr-1.5 h-3.5 w-3.5" /> Ligar a um contato
          </Button>
        )}
      </div>

      {open && (
        <div className="border-t px-3.5 py-2.5">
          <ul className="flex flex-col gap-1.5 text-sm">
            {debtor.charges.map((c) => {
              const l = lateLabel(c.daysLate);
              return (
                <li key={c.id} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                  <span className="tabular-nums font-medium">{brl(Number(c.value))}</span>
                  <span className="text-xs text-muted-foreground">
                    venc. {c.dueDate ? c.dueDate.split('-').reverse().join('/') : '—'}
                  </span>
                  <span className={cn('text-xs', l.tone)}>{l.text}</span>
                  <span className="text-xs text-muted-foreground">· {c.connectionLabel}</span>
                  {c.description && <span className="text-xs text-muted-foreground">· {c.description}</span>}
                  {c.invoiceUrl && (
                    <a
                      href={c.invoiceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2"
                    >
                      link de pagamento <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    onClick={async () => {
                      const raw = window.prompt(
                        `Novo vencimento para ${brl(Number(c.value))} (hoje vence ${c.dueDate ? c.dueDate.split('-').reverse().join('/') : '—'}).\nExemplo: 10/09, "dia 10" ou +7.\n\nO Asaas gera novo boleto/link e a régua dorme até a nova data.`,
                      );
                      if (!raw) return;
                      const r = await changeChargeDueDate(c.id, raw);
                      if (!r.ok) {
                        toast.error(r.error ?? 'Não deu para alterar.');
                        return;
                      }
                      toast.success(`Vencimento alterado para ${r.data!.dueDate.split('-').reverse().join('/')}${r.data!.invoiceUrl ? ' · novo link gerado' : ''}.`);
                      onChanged();
                    }}
                  >
                    alterar vencimento
                  </button>
                </li>
              );
            })}
          </ul>
          {debtor.paused && debtor.pausedReason && (
            <p className="mt-2.5 text-xs text-muted-foreground">Motivo da pausa: {debtor.pausedReason}</p>
          )}
          {debtor.contactId && (
            <button
              type="button"
              className="mt-2.5 inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2"
              onClick={async () => {
                await unlinkDebtor(debtor.key);
                toast.success('Contato desligado — voltou para as pendências.');
                onUnlink();
              }}
            >
              <Link2Off className="h-3 w-3" /> desligar contato
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ConnectionsPanel({
  conns,
  onChanged,
  onSync,
  filter,
  onFilter,
}: {
  conns: ConnectionView[];
  onChanged: () => void;
  onSync: (id: string) => void;
  /** Conta selecionada na carteira (null = todas). */
  filter: string | null;
  onFilter: (id: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dupFor, setDupFor] = useState<ConnectionView | null>(null);
  if (!conns.length) return null;

  const byLabel = { cpf: 'mesmo CPF/CNPJ', phone: 'mesmo telefone', email: 'mesmo e-mail' } as const;

  return (
    <div className="flex flex-col gap-2">
      {dupFor && (
        <Dialog open onOpenChange={(v) => !v && setDupFor(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Cadastros duplicados no Asaas · {dupFor.label}</DialogTitle>
              <DialogDescription>
                {dupFor.duplicatesCheckedAt
                  ? `Verificado em ${new Date(dupFor.duplicatesCheckedAt).toLocaleString('pt-BR')}. A régua não cobra devedor com parcela idêntica em dois cadastros — resolva no Asaas (apague o cadastro repetido) e verifique de novo.`
                  : 'Ainda não verificado.'}
              </DialogDescription>
            </DialogHeader>
            {dupFor.duplicatesReport.length ? (
              <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto text-sm">
                {dupFor.duplicatesReport.map((g) => (
                  <li key={`${g.by}-${g.key}`} className="rounded-md border px-3 py-2">
                    <p className="font-medium">
                      {g.customers.length} cadastros · {byLabel[g.by as keyof typeof byLabel] ?? g.by}
                    </p>
                    <ul className="mt-1 text-xs text-muted-foreground">
                      {g.customers.map((cu) => (
                        <li key={cu.id}>
                          {cu.name || 'Sem nome'} · <span className="font-mono">{cu.id}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">Nenhum cadastro repetido encontrado.</p>
            )}
          </DialogContent>
        </Dialog>
      )}
      {conns.map((c) => (
        <div
          key={c.id}
          className={cn(
            'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border bg-card px-3.5 py-2.5 text-sm',
            filter === c.id && 'border-primary/60 ring-1 ring-primary/30',
          )}
        >
          <Building2 className={cn('h-4 w-4', filter === c.id ? 'text-primary' : 'text-muted-foreground')} />
          {conns.length > 1 ? (
            <button
              type="button"
              onClick={() => onFilter(c.id)}
              className={cn('font-medium underline-offset-2 hover:underline', filter === c.id && 'text-primary')}
              title={filter === c.id ? 'Clique para voltar a ver todas as contas' : 'Clique para ver só as cobranças desta conta'}
            >
              {c.label}
            </button>
          ) : (
            <span className="font-medium">{c.label}</span>
          )}
          {c.environment === 'sandbox' && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              sandbox
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {c.openCharges} em aberto
            {c.lastSyncAt ? ` · atualizado ${new Date(c.lastSyncAt).toLocaleString('pt-BR')}` : ' · nunca sincronizado'}
          </span>

          {c.lastSyncError && (
            <span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
              <AlertTriangle className="h-3.5 w-3.5" /> {c.lastSyncError}
            </span>
          )}

          {c.webhookUrl && (
            <button
              type="button"
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]',
                c.webhookEvents
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                  : 'bg-muted text-muted-foreground',
              )}
              title={
                c.webhookEvents
                  ? `Último aviso do Asaas em ${new Date(c.webhookLastAt!).toLocaleString('pt-BR')}. Clique para copiar a URL de novo.`
                  : 'Clique para copiar a URL e colar no Asaas (Configurações → Integrações → Webhooks).'
              }
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(c.webhookUrl!);
                  toast.success('URL copiada. Cole no Asaas em Configurações → Integrações → Webhooks.');
                } catch {
                  toast.error('Não deu para copiar. A URL é: ' + c.webhookUrl);
                }
              }}
            >
              <ShieldCheck className="h-3 w-3" />
              {c.webhookEvents ? 'avisos de pagamento ligados' : 'ligar avisos de pagamento'}
              <Copy className="h-3 w-3" />
            </button>
          )}

          <button
            type="button"
            disabled={busyId === c.id}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] disabled:opacity-50',
              c.duplicatesCheckedAt && c.duplicatesReport.length
                ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
                : 'bg-muted text-muted-foreground',
            )}
            title="Procura cadastros repetidos no Asaas (mesmo CPF, telefone ou e-mail). Clique para verificar de novo; clique com a lista aberta para ver quem é."
            onClick={async () => {
              if (c.duplicatesCheckedAt && c.duplicatesReport.length && busyId !== c.id) {
                setDupFor(c);
                return;
              }
              setBusyId(c.id);
              try {
                const res = await checkAsaasDuplicates(c.id);
                if (!res.ok) {
                  toast.error(res.error ?? 'Não foi possível verificar.');
                  return;
                }
                const d = res.data!;
                if (d.groups.length) toast.warning(`${d.groups.length} ${d.groups.length === 1 ? 'grupo' : 'grupos'} de cadastros repetidos entre ${d.customers} clientes. Clique no selo para ver.`);
                else toast.success(`Nenhum cadastro repetido entre ${d.customers} clientes.`);
                onChanged();
              } finally {
                setBusyId(null);
              }
            }}
          >
            {busyId === c.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Users className="h-3 w-3" />}
            {!c.duplicatesCheckedAt
              ? 'verificar duplicados'
              : c.duplicatesReport.length
                ? `${c.duplicatesReport.length} ${c.duplicatesReport.length === 1 ? 'duplicado' : 'duplicados'}`
                : 'sem duplicados'}
          </button>

          <button
            type="button"
            disabled={busyId === c.id}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] disabled:opacity-50',
              c.notificationsOffAt ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-muted text-muted-foreground',
            )}
            title={
              c.notificationsOffAt
                ? `Avisos do Asaas desligados em ${new Date(c.notificationsOffAt).toLocaleString('pt-BR')} — o CRM é quem avisa. Clique para religar.`
                : 'Desliga os avisos do próprio Asaas (e-mail/SMS/WhatsApp que ele manda e cobra por envio) de TODOS os clientes desta conta. O CRM passa a ser quem fala. Reversível.'
            }
            onClick={async () => {
              const disable = !c.notificationsOffAt;
              if (
                !confirm(
                  disable
                    ? `Desligar os avisos do Asaas para TODOS os clientes de "${c.label}"? Eles deixam de receber e-mail/SMS/WhatsApp do Asaas — quem avisa passa a ser o CRM. Dá para religar depois.`
                    : `Religar os avisos do Asaas para todos os clientes de "${c.label}"? O Asaas volta a mandar (e cobrar por) e-mail/SMS/WhatsApp.`,
                )
              )
                return;
              setBusyId(c.id);
              try {
                const res = await setAsaasNotifications(c.id, disable);
                if (!res.ok) {
                  toast.error(res.error ?? 'Não foi possível mexer nos avisos.');
                  return;
                }
                const d = res.data!;
                toast.success(
                  `${d.changed} ${d.changed === 1 ? 'cliente alterado' : 'clientes alterados'}` +
                    (d.alreadyDone ? ` · ${d.alreadyDone} já estavam assim` : '') +
                    (d.failed ? ` · ${d.failed} falharam` : '') +
                    (d.remaining ? ` · faltam ${d.remaining}: clique de novo` : ''),
                  { duration: 8000 },
                );
                onChanged();
              } finally {
                setBusyId(null);
              }
            }}
          >
            <BellOff className="h-3 w-3" />
            {c.notificationsOffAt ? 'avisos do Asaas desligados' : 'desligar avisos do Asaas'}
          </button>

          <div className="ml-auto flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => onSync(c.id)}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (
                  !confirm(
                    `Remover a conexão "${c.label}"? As ${c.openCharges} cobranças espelhadas dela saem daqui. Nada é alterado no Asaas.`,
                  )
                )
                  return;
                const res = await removeConnection(c.id);
                if (!res.ok) toast.error(res.error ?? 'Não foi possível remover.');
                else toast.success(`"${c.label}" desconectada.`);
                onChanged();
              }}
            >
              <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Nova cobrança à mão: contato, valor, vencimento, descrição, conta do Asaas e
 * (opcional) o link já vai na conversa. É o "cria uma cobrança de tanto pro
 * fulano" sem depender da IA.
 */
function NewChargeDialog({
  conns,
  onClose,
  onCreated,
}: {
  conns: ConnectionView[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [contactId, setContactId] = useState('');
  const [connectionId, setConnectionId] = useState<string>(conns[0]?.id ?? '');
  const [valueRaw, setValueRaw] = useState('');
  const [dueDate, setDueDate] = useState(() => new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10));
  const [description, setDescription] = useState('');
  const [sendLink, setSendLink] = useState(true);
  // 09/09 (João/GoLink): "dá pra escolher só Pix?" e "cadê o CPF?".
  const [billingType, setBillingType] = useState<'UNDEFINED' | 'PIX' | 'BOLETO' | 'CREDIT_CARD'>('UNDEFINED');
  const [cpfCnpj, setCpfCnpj] = useState('');
  // 📄 11/09 (João/GoLink): "precisa ter email e endereço completo, pois precisa
  // pra depois o Asaas emitir nota fiscal". Fica guardado no Asaas — preenche
  // uma vez por cliente. Cidade e estado o Asaas resolve pelo CEP.
  const [nfOpen, setNfOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [address, setAddress] = useState('');
  const [addressNumber, setAddressNumber] = useState('');
  const [complement, setComplement] = useState('');
  const [province, setProvince] = useState('');
  // 10/09 (João/GoLink): "trabalho com assinatura — todo mês chega a cobrança, sem término".
  const [kind, setKind] = useState<'single' | 'subscription'>('single');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ url: string; sentVia: string | null; sendError: string | null; reused: boolean; subscription: boolean } | null>(null);

  const valueOk = parseValue(valueRaw) != null;
  const dueOk = parseDueDate(dueDate) != null;
  const cpfDigits = cpfCnpj.replace(/\D/g, '');
  const cpfOk = cpfDigits.length === 0 || cpfDigits.length === 11 || cpfDigits.length === 14;
  const canSubmit = !!contactId && valueOk && dueOk && cpfOk && description.trim().length >= 3 && !busy;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nova cobrança no Asaas</DialogTitle>
          <DialogDescription>
            Gera a cobrança na conta do Asaas ligada aqui. A cobrança entra na carteira e, se o cliente pagar, o webhook fecha sozinho.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="flex flex-col gap-3 text-sm">
            <p className="font-medium">
              {done.reused
                ? 'Já existia uma cobrança igual aberta, criada há pouco — reaproveitei o link.'
                : done.subscription
                  ? 'Assinatura mensal criada no Asaas. Todo mês ele gera a cobrança sozinho, sem data de fim.'
                  : 'Cobrança criada.'}
            </p>
            {done.subscription && !done.url && (
              <p className="text-muted-foreground">
                O Asaas ainda vai gerar a 1ª cobrança. Ela entra na carteira sozinha e o lembrete manda o link ao cliente.
              </p>
            )}
            {done.sentVia && <p>Link enviado por {done.sentVia}.</p>}
            {done.sendError && <p className="text-amber-700 dark:text-amber-400">O link não foi enviado ({done.sendError}). Mande você:</p>}
            {done.url && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-2">
              <a href={done.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-primary underline underline-offset-2">
                {done.url}
              </a>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(done.url);
                    toast.success('Link copiado.');
                  } catch {
                    toast.error('Não deu para copiar — selecione o link e copie.');
                  }
                }}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" /> Copiar
              </Button>
            </div>
            )}
            <div className="flex justify-end">
              <Button onClick={onClose}>Fechar</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Contato</Label>
              <ContactPicker value={contactId} onChange={(id) => setContactId(id)} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nc-kind">Tipo</Label>
              <select
                id="nc-kind"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                <option value="single">Cobrança única</option>
                <option value="subscription">Assinatura mensal (repete todo mês, sem data de fim)</option>
              </select>
              {kind === 'subscription' && (
                <p className="text-xs text-muted-foreground">
                  Igual à assinatura do Asaas: ele gera uma cobrança por mês, a partir do 1º vencimento. Cada mensalidade entra na carteira,
                  recebe o lembrete antes de vencer e a cobrança se atrasar. Para encerrar, cancele a assinatura no Asaas.
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nc-value">{kind === 'subscription' ? 'Valor mensal (R$)' : 'Valor (R$)'}</Label>
                <Input id="nc-value" inputMode="decimal" placeholder="125,00" value={valueRaw} onChange={(e) => setValueRaw(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nc-due">{kind === 'subscription' ? '1º vencimento' : 'Vencimento'}</Label>
                <Input id="nc-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nc-desc">Descrição (vai no boleto/Pix)</Label>
              <Input id="nc-desc" placeholder="Ex.: Botijão P-13 · pedido 1234" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nc-billing">Forma de pagamento</Label>
                <select
                  id="nc-billing"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={billingType}
                  onChange={(e) => setBillingType(e.target.value as typeof billingType)}
                >
                  <option value="UNDEFINED">Cliente escolhe (Pix, boleto ou cartão)</option>
                  <option value="PIX">Só Pix</option>
                  {/* 11/09 (João/GoLink): "deixa boleto e Pix, tira o cartão".
                      No Asaas o boleto já sai com o QR Code do Pix no mesmo
                      link quando a conta tem chave Pix — é a opção "Boleto
                      Bancário / Pix" do painel deles. Não existe combinar dois
                      billingType, então este é o caminho. */}
                  <option value="BOLETO">Boleto e Pix (sem cartão)</option>
                  <option value="CREDIT_CARD">Só cartão</option>
                </select>
                {billingType === 'BOLETO' && (
                  <p className="text-xs text-muted-foreground">
                    O boleto sai com o QR Code do Pix no mesmo link. Se a conta do Asaas não tiver chave Pix cadastrada, vai só o boleto.
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nc-cpf">CPF/CNPJ do cliente</Label>
                <Input
                  id="nc-cpf"
                  inputMode="numeric"
                  placeholder="só se o cadastro não tiver"
                  value={cpfCnpj}
                  onChange={(e) => setCpfCnpj(e.target.value)}
                  aria-invalid={!cpfOk}
                  className={cn(!cpfOk && 'border-red-500')}
                />
              </div>
            </div>
            <p className="-mt-1 text-xs text-muted-foreground">
              O Asaas de produção exige CPF/CNPJ pra emitir. Se o contato já tem no cadastro (ou já é cliente do Asaas), pode deixar em branco.
            </p>

            {conns.length > 1 && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nc-conn">Conta do Asaas</Label>
                <select
                  id="nc-conn"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={connectionId}
                  onChange={(e) => setConnectionId(e.target.value)}
                >
                  {conns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                      {c.environment === 'sandbox' ? ' (sandbox)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* 📄 Dados de nota fiscal: dobrado, porque a maioria das cobranças
                não precisa. Vai tudo pro cadastro do Asaas e fica lá. */}
            <div className="rounded-lg border border-dashed">
              <button
                type="button"
                onClick={() => setNfOpen((v) => !v)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium"
              >
                <span>
                  E-mail e endereço (para nota fiscal)
                  <span className="block text-xs font-normal text-muted-foreground">
                    Opcional. O Asaas só emite nota com endereço completo. Preenche uma vez e fica no cadastro dele.
                  </span>
                </span>
                <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', nfOpen && 'rotate-180')} />
              </button>

              {nfOpen && (
                <div className="flex flex-col gap-3 border-t px-3 py-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="nc-email">E-mail do cliente</Label>
                    <Input
                      id="nc-email"
                      type="email"
                      placeholder="cliente@empresa.com.br"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="nc-cep">CEP</Label>
                      <Input id="nc-cep" inputMode="numeric" placeholder="12345-678" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
                    </div>
                    <div className="col-span-2 flex flex-col gap-1.5">
                      <Label htmlFor="nc-rua">Rua</Label>
                      <Input id="nc-rua" placeholder="Av. Brasil" value={address} onChange={(e) => setAddress(e.target.value)} />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="nc-num">Número</Label>
                      <Input id="nc-num" placeholder="47" value={addressNumber} onChange={(e) => setAddressNumber(e.target.value)} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="nc-compl">Complemento</Label>
                      <Input id="nc-compl" placeholder="sala 2" value={complement} onChange={(e) => setComplement(e.target.value)} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="nc-bairro">Bairro</Label>
                      <Input id="nc-bairro" placeholder="Centro" value={province} onChange={(e) => setProvince(e.target.value)} />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">Cidade e estado o Asaas preenche pelo CEP.</p>
                </div>
              )}
            </div>

            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={sendLink} onChange={(e) => setSendLink(e.target.checked)} />
              <span>
                Mandar o link na conversa agora
                <span className="block text-xs text-muted-foreground">
                  Pelo canal configurado em Ajustar (WhatsApp e/ou e-mail). Se o contato não tiver conversa, ela é aberta.
                </span>
              </span>
            </label>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancelar
              </Button>
              <Button
                disabled={!canSubmit}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const res = await createChargeManual({
                      contactId,
                      connectionId: conns.length > 1 ? connectionId || null : null,
                      valueRaw,
                      dueDate,
                      description,
                      sendLink,
                      billingType,
                      cpfCnpj: cpfDigits || undefined,
                      recurring: kind === 'subscription' ? 'MONTHLY' : undefined,
                      email: email.trim() || undefined,
                      postalCode: postalCode.trim() || undefined,
                      address: address.trim() || undefined,
                      addressNumber: addressNumber.trim() || undefined,
                      complement: complement.trim() || undefined,
                      province: province.trim() || undefined,
                    });
                    if (!res.ok) {
                      toast.error(res.error ?? 'Não foi possível gerar a cobrança.');
                      return;
                    }
                    const d = res.data!;
                    setDone({ url: d.invoiceUrl, sentVia: d.sentVia, sendError: d.sendError, reused: d.reused, subscription: !!d.subscriptionId });
                    toast.success(
                      d.subscriptionId
                        ? d.sentVia
                          ? `Assinatura criada e link da 1ª cobrança enviado por ${d.sentVia}.`
                          : 'Assinatura mensal criada.'
                        : d.sentVia
                          ? `Cobrança gerada e link enviado por ${d.sentVia}.`
                          : 'Cobrança gerada.',
                    );
                    onCreated();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Receipt className="mr-1.5 h-3.5 w-3.5" />}
                {kind === 'subscription' ? 'Criar assinatura' : 'Gerar cobrança'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed px-6 py-14 text-center">
      <Building2 className="h-7 w-7 text-muted-foreground" />
      <div>
        <p className="font-medium">Nenhuma conta do Asaas conectada</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          Conecte cada conta que emite cobrança. Dá para ligar mais de uma — elas aparecem juntas na mesma carteira, e a
          origem de cada cobrança continua identificada.
        </p>
      </div>
      <Button onClick={onAdd}>
        <Plus className="mr-1.5 h-4 w-4" /> Conectar Asaas
      </Button>
    </div>
  );
}

function AddConnectionDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [environment, setEnvironment] = useState<'sandbox' | 'production'>('sandbox');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const res = await saveConnection({ label, apiKey, environment });
      if (!res.ok) {
        toast.error(res.error ?? 'Não foi possível salvar.');
        return;
      }
      toast.success(`"${label}" conectada. Toque em Atualizar para trazer a carteira.`);
      setLabel('');
      setApiKey('');
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Conectar uma conta do Asaas</DialogTitle>
          <DialogDescription>
            A chave é guardada criptografada e nunca mais aparece na tela. Conferimos o acesso antes de salvar.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="asaas-label">Nome desta conta</Label>
            <Input
              id="asaas-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Minha conta"
            />
            <p className="text-xs text-muted-foreground">
              Como você reconhece essa conta — aparece ao lado de cada cobrança.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="asaas-env">Ambiente</Label>
            <Select value={environment} onValueChange={(v) => setEnvironment(v as 'sandbox' | 'production')}>
              <SelectTrigger id="asaas-env">
                <SelectValue>{environment === 'sandbox' ? 'Sandbox (teste)' : 'Produção (cobranças reais)'}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sandbox">Sandbox (teste)</SelectItem>
                <SelectItem value="production">Produção (cobranças reais)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              A chave precisa ser do mesmo ambiente escolhido aqui, senão o Asaas recusa.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="asaas-key">Chave de API</Label>
            <Input
              id="asaas-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="$aact_..."
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              No Asaas: Configurações → Integrações → API. Copie a chave inteira, inclusive o começo com $.
            </p>
          </div>

          <Button onClick={save} disabled={saving || !label.trim() || !apiKey.trim()}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {saving ? 'Conferindo o acesso…' : 'Conectar'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LinkContactDialog({
  debtor,
  onClose,
  onLinked,
}: {
  debtor: WalletDebtor | null;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ContactOption[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!debtor) return;
    // Já começa procurando pelo nome que veio do Asaas — na maioria das vezes
    // o contato certo aparece sem ninguém digitar nada.
    setQ(debtor.name === 'Sem nome' ? '' : debtor.name);
  }, [debtor]);

  useEffect(() => {
    if (!debtor) return;
    let alive = true;
    const t = setTimeout(async () => {
      const r = await searchContactsForCharge(q).catch(() => []);
      if (alive) setResults(r);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, debtor]);

  if (!debtor) return null;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{debtor.contactId ? 'Trocar o contato desta cobrança' : 'Ligar a um contato do CRM'}</DialogTitle>
          <DialogDescription>
            {debtor.name} · {brl(debtor.total)} em {debtor.charges.length === 1 ? '1 cobrança' : `${debtor.charges.length} cobranças`}
            {debtor.phone ? ` · ${debtor.phone}` : ''}
            {debtor.contactId ? '. A cobrança passa a sair na conversa do contato que você escolher.' : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome, telefone ou e-mail" className="pl-8" />
        </div>

        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {results.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={busy}
              className="rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
              onClick={async () => {
                setBusy(true);
                const res = await linkDebtorToContact(debtor.key, c.id);
                setBusy(false);
                if (!res.ok) {
                  toast.error(res.error ?? 'Não foi possível ligar.');
                  return;
                }
                toast.success(
                  `Ligado a ${c.name}. ${res.data!.linked === 1 ? '1 cobrança' : `${res.data!.linked} cobranças`} atualizadas.`,
                );
                onClose();
                onLinked();
              }}
            >
              <span className="font-medium">{c.name}</span>
              <span className="block text-xs text-muted-foreground">
                {c.phone}
                {c.email ? ` · ${c.email}` : ''}
              </span>
            </button>
          ))}
          {!results.length && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {q.trim().length < 2 ? 'Digite ao menos 2 letras.' : 'Nenhum contato encontrado com esse termo.'}
            </p>
          )}
        </div>

        <div className="rounded-md border border-dashed px-3 py-2.5 text-sm">
          <p className="font-medium">Ou criar um contato novo com os dados do Asaas</p>
          <p className="text-xs text-muted-foreground">
            {debtor.name}
            {debtor.phone ? ` · ${debtor.phone}` : ''}
            {debtor.email ? ` · ${debtor.email}` : ''}
            {!debtor.phone && !debtor.email ? ' · sem telefone nem e-mail no Asaas' : ''}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            disabled={busy || (!debtor.phone && !debtor.email)}
            onClick={async () => {
              setBusy(true);
              const res = await createContactForDebtor(debtor.key);
              setBusy(false);
              if (!res.ok) {
                toast.error(res.error ?? 'Não foi possível criar o contato.');
                return;
              }
              const n = res.data!.linked;
              toast.success(
                res.data!.created
                  ? `Contato criado e ligado. ${n === 1 ? '1 cobrança' : `${n} cobranças`} atualizadas.`
                  : `Já existia um contato com esse telefone — as cobranças foram ligadas a ele.`,
              );
              onClose();
              onLinked();
            }}
          >
            <UserPlus className="mr-1.5 h-3.5 w-3.5" /> Criar contato e ligar
          </Button>
          {!debtor.phone && !debtor.email && (
            <p className="mt-1.5 text-xs text-muted-foreground">Sem telefone nem e-mail não dá para criar: cadastre o contato na mão e ligue aqui em cima.</p>
          )}
          {!debtor.phone && debtor.email && (
            <p className="mt-1.5 text-xs text-muted-foreground">Só e-mail: este devedor será cobrado por e-mail (precisa de um canal de e-mail conectado).</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A régua: com que frequência cobra, a partir de quando, em que janela e com
 * que teto. Tudo isto é configuração por conta — nenhuma regra de negócio de
 * cliente nenhum vira condição no código.
 */
function RulePanel({
  rule,
  running,
  onSaved,
  onRun,
}: {
  rule: CollectionsSettings;
  running: boolean;
  onSaved: (r: CollectionsSettings) => void;
  onRun: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CollectionsSettings>(rule);
  const [saving, setSaving] = useState(false);
  const [chans, setChans] = useState<CollectionChannelOption[] | null>(null);
  const [people, setPeople] = useState<CollectionAssigneeOption[] | null>(null);
  const [sectorsList, setSectorsList] = useState<CollectionSectorOption[] | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(rule);

  useEffect(() => setDraft(rule), [rule]);
  useEffect(() => {
    if (open && chans === null) {
      void listCollectionChannels()
        .then(setChans)
        .catch(() => setChans([]));
    }
    if (open && people === null) {
      void listCollectionAssignees()
        .then(setPeople)
        .catch(() => setPeople([]));
    }
    if (open && sectorsList === null) {
      void listCollectionSectors()
        .then(setSectorsList)
        .catch(() => setSectorsList([]));
    }
  }, [open, chans, people, sectorsList]);

  async function persist(patch: Partial<CollectionsSettings>) {
    setSaving(true);
    try {
      const res = await saveCollectionsSettings(patch);
      if (!res.ok) {
        toast.error(res.error ?? 'Não foi possível salvar.');
        return false;
      }
      onSaved(res.data!);
      setDraft(res.data!);
      return true;
    } catch (err) {
      // Erro LANÇADO (aba aberta desde antes de um deploy, rede): antes ficava
      // mudo — o botão "Salvar" não fazia nada e o aviso "alterações não salvas"
      // continuava (João, 10/09: "40 → 50 não deixa salvar").
      if (isStaleActionError(err)) {
        reloadForStaleAction();
        return false;
      }
      toast.error(err instanceof Error && err.message ? err.message : 'Não foi possível salvar. Recarregue a página (F5) e tente de novo.');
      return false;
    } finally {
      setSaving(false);
    }
  }

  const num = (k: keyof CollectionsSettings, label: string, hint: string, min: number, max: number) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`rule-${String(k)}`}>{label}</Label>
      <Input
        id={`rule-${String(k)}`}
        type="number"
        min={min}
        max={max}
        value={String(draft[k] ?? '')}
        onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })}
        className="w-28"
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );

  return (
    <div className={cn('rounded-md border bg-card', rule.enabled ? 'border-emerald-600/40' : '')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3">
        <Settings2 className="h-4 w-4 text-muted-foreground" />
        <div className="flex-1">
          <p className="font-medium">
            Régua de cobrança{' '}
            <span className={cn('text-sm font-normal', rule.enabled ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground')}>
              · {rule.enabled ? 'ligada' : 'desligada'}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {rule.enabled
              ? `A cada ${rule.intervalDays} ${rule.intervalDays === 1 ? 'dia' : 'dias'}, das ${rule.startHour}h às ${rule.endHour}h, ${describeWeekdays(rule.sendWeekdays)}${rule.skipHolidays ? ' (feriado nacional não)' : ''}, no máximo ${rule.dailyCap} por dia. Para depois de ${rule.maxTouches} toques sem resposta.` +
                (rule.autoSend
                  ? ` Envia sozinha, uma a cada ${rule.sendEveryMinutes} min.`
                  : ' Cada cobrança espera sua aprovação em "Precisa de você".')
              : 'Ninguém é cobrado enquanto ela estiver desligada.'}
          </p>
        </div>

        <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
          Ajustar
        </Button>
        <Button
          size="sm"
          variant={rule.enabled ? 'outline' : 'default'}
          disabled={saving}
          onClick={async () => {
            const ligando = !rule.enabled;
            if (
              ligando &&
              !confirm(
                rule.autoSend
                  ? `Ligar a régua? Ela vai montar as cobranças a cada ${rule.intervalDays} dias e ENVIAR SOZINHA, uma a cada ${rule.sendEveryMinutes} min, das ${rule.startHour}h às ${rule.endHour}h. Antes de cada envio o sistema confere se a parcela continua em aberto.`
                  : `Ligar a régua? Ela vai montar as cobranças a cada ${rule.intervalDays} dias e deixar em "Precisa de você" para você aprovar. Nenhuma mensagem sai sozinha.`,
              )
            )
              return;
            const ok = await persist({ enabled: ligando });
            if (ok)
              toast.success(
                ligando
                  ? rule.autoSend
                    ? `Régua ligada. As cobranças saem sozinhas, uma a cada ${rule.sendEveryMinutes} min.`
                    : 'Régua ligada. Nada sai sem sua aprovação.'
                  : 'Régua desligada — ninguém será cobrado.',
              );
          }}
        >
          {rule.enabled ? 'Desligar' : 'Ligar régua'}
        </Button>
        <Button size="sm" disabled={running || !rule.enabled} onClick={() => void onRun()}>
          {running ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
          Rodar agora
        </Button>
      </div>

      {open && (
        <div className="flex flex-col gap-4 border-t px-3.5 py-4">
          <div className="flex flex-wrap gap-6">
            {num('intervalDays', 'Cobrar a cada', 'Dias entre um toque e o próximo no mesmo devedor.', 1, 60)}
            {num('minDaysOverdue', 'A partir de', 'Dias de atraso para entrar na régua.', 0, 365)}
            {num('dailyCap', 'Máximo por dia', 'Teto de devedores cobrados por dia.', 1, 500)}
            {num('maxTouches', 'Parar depois de', 'Toques sem resposta antes de devolver para uma pessoa.', 1, 50)}
            {num('emitMaxValue', 'IA pode cobrar até (R$)', 'Teto da ferramenta "Gerar cobrança no Asaas": acima disso a IA não cria sozinha — avisa uma pessoa.', 1, 100000)}
            {num('reminderDaysBefore', 'Lembrar antes de vencer (dias)', '0 = desligado. Com 3, quem tem parcela vencendo nos próximos 3 dias recebe um aviso leve — não é cobrança. Passa pela mesma fila e teto.', 0, 15)}
            {num('sendEveryMinutes', 'Uma mensagem a cada (min)', 'Cadência do envio automático e do "Aprovar todas": espaçar as mensagens é o que evita o bloqueio do número.', 1, 120)}
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={draft.autoSend}
              onChange={(e) => {
                const on = e.target.checked;
                if (
                  on &&
                  !confirm(
                    `Enviar sozinha? As cobranças vão sair SEM passar por "Precisa de você" — uma a cada ${draft.sendEveryMinutes} min, das ${draft.startHour}h às ${draft.endHour}h. Antes de cada envio o sistema confere no Asaas se a parcela continua em aberto. Dá para desligar quando quiser.`,
                  )
                )
                  return;
                setDraft({ ...draft, autoSend: on });
              }}
            />
            <span>
              Enviar sozinha, sem passar por &quot;Precisa de você&quot;
              <span className="block text-xs text-muted-foreground">
                Decisão sua: a régua manda direto pelo canal configurado, uma a cada {draft.sendEveryMinutes} min, no horário acima. Os freios
                continuam valendo — IA pausada na conta, cliente que pediu para não receber, conversa com a IA desligada. Desmarcado, cada
                cobrança espera sua aprovação (e o automático por evidência libera depois de 20 decisões em 14 dias).
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={draft.thankOnPayment}
              onChange={(e) => setDraft({ ...draft, thankOnPayment: e.target.checked })}
            />
            <span>
              Agradecer quando o pagamento entrar
              <span className="block text-xs text-muted-foreground">
                Quando o Asaas avisa que a cobrança foi paga, o CRM manda um &quot;recebemos, obrigado&quot; — só para quem a régua cobrou ou cuja
                cobrança nasceu aqui. Nunca para quem o CRM nunca falou.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={draft.promiseUpdatesDueDate}
              onChange={(e) => setDraft({ ...draft, promiseUpdatesDueDate: e.target.checked })}
            />
            <span>
              Quando o cliente prometer uma data, mover o vencimento no Asaas
              <span className="block text-xs text-muted-foreground">
                &quot;Pago dia 10&quot; passa a mover o boleto para o dia 10 (novo link), além de a régua dormir até lá. Só com uma parcela em
                aberto. Atenção: juros e multa do Asaas passam a contar da data nova.
              </span>
            </span>
          </label>

          <div className="flex flex-wrap items-end gap-6">
            {num('startHour', 'Começa às', 'Hora de início, no fuso da conta.', 0, 23)}
            {num('endHour', 'Termina às', 'Hora de término.', 1, 24)}
          </div>

          {/* 📆 11/09 (Alex, a partir do João): "cada um tem sua forma de
              trabalhar — quem cobra no sábado deixa de segunda a sábado, quem
              não cobra deixa de segunda a sexta". O antigo "só dias úteis" não
              dava esse meio-termo. */}
          <div className="flex flex-col gap-2">
            <Label>Dias em que a régua cobra</Label>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAY_SHORT.map((nome, dia) => {
                const ligado = draft.sendWeekdays.includes(dia);
                return (
                  <button
                    key={dia}
                    type="button"
                    aria-pressed={ligado}
                    onClick={() => {
                      const dias = ligado ? draft.sendWeekdays.filter((d) => d !== dia) : [...draft.sendWeekdays, dia].sort();
                      // Sem nenhum dia a régua nunca cobraria e a tela não
                      // explicaria o silêncio — para desligar existe o botão da régua.
                      if (!dias.length) {
                        toast.error('Deixe pelo menos um dia. Para parar de cobrar, desligue a régua.');
                        return;
                      }
                      setDraft({ ...draft, sendWeekdays: dias, weekdaysOnly: dias.every((d) => d >= 1 && d <= 5) });
                    }}
                    className={cn(
                      'h-8 min-w-[3rem] rounded-md border px-2 text-xs font-medium transition',
                      ligado ? 'border-primary bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {nome}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">Cobra {describeWeekdays(draft.sendWeekdays)}.</p>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={draft.skipHolidays}
              onChange={(e) => setDraft({ ...draft, skipHolidays: e.target.checked })}
            />
            <span>
              Não cobrar em feriado nacional
              <span className="block text-xs text-muted-foreground">
                Natal, Ano-Novo, Carnaval, Sexta-feira Santa, Tiradentes, Trabalho, Corpus Christi, Independência, Aparecida, Finados,
                Proclamação da República e Consciência Negra. Feriado da sua cidade não entra — para esse, desmarque o dia na régua.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={draft.asaasNotificationsOff}
              onChange={(e) => setDraft({ ...draft, asaasNotificationsOff: e.target.checked })}
            />
            <span>
              O CRM assume os avisos: desligar as notificações do Asaas de quem entra na carteira
              <span className="block text-xs text-muted-foreground">
                O Asaas cobra por cada e-mail/SMS/WhatsApp que ele mesmo manda. Ligado, a cada sincronização a régua desliga esses avisos nos
                clientes da carteira — e passa a ser quem fala. Para desligar de todos os clientes da conta de uma vez, use o selo na linha da conta.
              </span>
            </span>
          </label>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-channel-kind">Por onde cobrar</Label>
            <select
              id="rule-channel-kind"
              className="h-9 w-full max-w-sm rounded-md border bg-background px-2 text-sm"
              value={draft.channel}
              onChange={(e) => setDraft({ ...draft, channel: e.target.value as CollectionsSettings['channel'] })}
            >
              <option value="auto">Automático: WhatsApp quando tem telefone, senão e-mail</option>
              <option value="whatsapp">Só WhatsApp</option>
              <option value="email">Só e-mail</option>
              <option value="both">WhatsApp e e-mail, os dois no mesmo toque</option>
            </select>
            <p className="text-xs text-muted-foreground">
              E-mail precisa de um canal de e-mail conectado em Canais e do e-mail no contato (o do Asaas entra ao criar o contato).
              A fila mostra por onde cada cobrança vai.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-channel">Número que envia as cobranças</Label>
            <select
              id="rule-channel"
              className="h-9 w-full max-w-sm rounded-md border bg-background px-2 text-sm"
              value={draft.channelId ?? ''}
              onChange={(e) => setDraft({ ...draft, channelId: e.target.value || null })}
            >
              <option value="">Automático (o único número conectado)</option>
              {(chans ?? []).map((c) => (
                <option key={c.id} value={c.id} disabled={!c.connected}>
                  {c.name}
                  {c.phone ? ` · ${c.phone}` : ''}
                  {c.connected ? '' : ' (desconectado)'}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Vale para o devedor que ainda não tem conversa no CRM: a régua abre a conversa por este número. Com mais de um número
              conectado ela não chuta — escolha aqui.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-assignee">Quem cuida das respostas</Label>
            <select
              id="rule-assignee"
              className="h-9 w-full max-w-sm rounded-md border bg-background px-2 text-sm"
              value={draft.assigneeUserId ?? ''}
              onChange={(e) => setDraft({ ...draft, assigneeUserId: e.target.value || null })}
            >
              <option value="">Ninguém em especial (não mexe na atribuição)</option>
              {(people ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.role === 'owner' ? ' · dono' : p.role === 'admin' ? ' · admin' : p.role === 'supervisor' ? ' · supervisor' : ''}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Ao sair uma cobrança, a conversa passa a ser dessa pessoa: aparece na lista dela e a resposta do cliente (&quot;já paguei&quot;,
              &quot;pago dia 10&quot;) cai com quem resolve — mesmo que a conversa estivesse com outro atendente.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-sector">Setor das conversas de cobrança</Label>
            <select
              id="rule-sector"
              className="h-9 w-full max-w-sm rounded-md border bg-background px-2 text-sm"
              value={draft.sectorId ?? ''}
              onChange={(e) => setDraft({ ...draft, sectorId: e.target.value || null })}
            >
              <option value="">Não mexer no setor</option>
              {(sectorsList ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Toda conversa em que o robô mandar cobrança entra neste setor (ex.: &quot;Asaas&quot; ou &quot;Cobrança&quot;) — assim não mistura com
              vendas e atendimento. Crie o setor em Configurações → Setores e coloque nele quem cuida das respostas.
            </p>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={draft.offerDateNegotiation}
              onChange={(e) => setDraft({ ...draft, offerDateNegotiation: e.target.checked })}
            />
            <span>
              Oferecer &quot;combinar uma data&quot; no fim da mensagem
              <span className="block text-xs text-muted-foreground">
                Desmarcado, a mensagem só diz que, se já pagou, é só responder por aqui — sem abrir a porta pra adiar. A resposta do cliente
                continua pausando a régua nele.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={draft.showValues}
              onChange={(e) => setDraft({ ...draft, showValues: e.target.checked })}
            />
            <span>
              Mostrar os valores na mensagem
              <span className="block text-xs text-muted-foreground">
                Marcado: cada parcela sai com o valor (e o valor com juros e multa, quando o Asaas informa) e o total. Desmarcado: só o
                vencimento, os dias de atraso e o link de cada parcela — o valor o cliente vê no link. Vale também para o lembrete.
              </span>
            </span>
          </label>

          <div className="flex flex-col gap-2">
            <Label>O que a régua considera cobrável</Label>
            {CHARGEABLE_STATUSES.map((s) => (
              <label key={s.value} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={draft.overdueStatuses.includes(s.value)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...draft.overdueStatuses, s.value]
                      : draft.overdueStatuses.filter((v) => v !== s.value);
                    // Desmarcar tudo deixaria a régua sem nada para fazer.
                    setDraft({ ...draft, overdueStatuses: next.length ? next : ['OVERDUE'] });
                  }}
                />
                <span>
                  {s.label}
                  <span className="block text-xs text-muted-foreground">{s.hint}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-tone">Tom das mensagens</Label>
            <Input
              id="rule-tone"
              value={draft.tone}
              onChange={(e) => setDraft({ ...draft, tone: e.target.value })}
              placeholder="Ex.: informal, tratamos o cliente por você, sem formalidade"
            />
            <p className="text-xs text-muted-foreground">
              A IA nunca oferece desconto, prazo ou parcelamento, e nunca fala em juros, protesto ou negativação — isso é
              decisão de gente, não de régua.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={!dirty || saving}
              onClick={async () => {
                const ok = await persist(draft);
                if (ok) toast.success('Régua salva.');
              }}
            >
              {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Salvar
            </Button>
            {dirty && <span className="text-xs text-amber-600 dark:text-amber-500">alterações não salvas</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Em uma linha: onde a régua está neste devedor. */
function reguaStatus(d: WalletDebtor): string {
  if (!d.contactId) return 'Sem contato ligado — a régua não cobra este devedor.';
  if (d.duplicateSuspect) return 'Parcela idêntica em dois cadastros do Asaas — a régua não cobra até resolver lá.';
  if (d.paused) return 'Fora da régua: marcado como "não cobrar".';
  if (hasPromise(d)) {
    return `Promessa: a régua dorme até ${new Date(d.snoozeUntil!).toLocaleDateString('pt-BR')}${d.snoozeReason ? ` · ${d.snoozeReason}` : ''}.`;
  }
  if (!d.touchCount) return 'Ainda não foi cobrado pela régua.';
  const quando = d.lastTouchAt ? new Date(d.lastTouchAt).toLocaleDateString('pt-BR') : null;
  return `${d.touchCount} ${d.touchCount === 1 ? 'cobrança enviada' : 'cobranças enviadas'}${quando ? `, a última em ${quando}` : ''}.`;
}

/**
 * Tirar um devedor da régua. O motivo é obrigatório porque quem abrir isso
 * daqui a dois meses precisa saber por que este cliente nunca é cobrado —
 * "acordo em andamento" e "esqueceram de religar" têm a mesma cara sem ele.
 */
/** Régua dorme até a data em que o cliente prometeu pagar (10/09, pedido do Alex/João). */
function hasPromise(d: { snoozeUntil: string | null }): boolean {
  return !!d.snoozeUntil && new Date(d.snoozeUntil).getTime() > Date.now();
}

/**
 * "Registrar promessa": o cliente disse "pago dia 15" por telefone, num áudio
 * que a IA não leu, ou pro Leonardo. Mesmo efeito do marcador da IA — a régua
 * dorme até a data (+1 dia), o boleto move junto se "mover vencimento" estiver
 * ligado em Ajustar, e fica nota na conversa.
 */
function PromiseDialog({
  debtor,
  onClose,
  onSaved,
}: {
  debtor: WalletDebtor | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDate(new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10));
    setNote('');
  }, [debtor]);

  if (!debtor || !debtor.contactId) return null;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{hasPromise(debtor) ? 'Mudar a data prometida' : 'Promessa de pagamento'} — {debtor.name}</DialogTitle>
          <DialogDescription>
            A régua para de cobrar este cliente até o dia seguinte à data. Se ele não pagar, volta a cobrar sozinha. A promessa fica registrada
            na conversa.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="promise-date">Prometeu pagar em</Label>
            <Input id="promise-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="promise-note">Observação (opcional)</Label>
          <Textarea id="promise-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: falou por telefone que recebe do governo na segunda" rows={2} />
        </div>

        <Button
          disabled={saving || !date}
          onClick={async () => {
            setSaving(true);
            try {
              const res = await registerPaymentPromise({ contactId: debtor.contactId!, dateRaw: date, note: note.trim() || null });
              if (!res.ok) {
                toast.error(res.error ?? 'Não foi possível registrar.');
                return;
              }
              toast.success(`Promessa registrada: a régua dorme em ${debtor.name} até depois de ${date.split('-').reverse().join('/')}.`);
              onClose();
              onSaved();
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CalendarClock className="mr-1.5 h-4 w-4" />}
          Registrar promessa
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function PauseDebtorDialog({
  debtor,
  onClose,
  onSaved,
}: {
  debtor: WalletDebtor | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setReason('');
  }, [debtor]);

  if (!debtor || !debtor.contactId) return null;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Não cobrar {debtor.name}</DialogTitle>
          <DialogDescription>
            A régua para neste devedor e não monta mais nenhuma cobrança para ele. As {debtor.charges.length === 1 ? 'cobranças continuam' : 'cobranças continuam'} aparecendo
            na carteira, e nada muda no Asaas — só paramos de mandar mensagem.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pause-reason">Por quê?</Label>
          <Textarea
            id="pause-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ex.: acordo fechado por fora · cliente antigo, o dono cobra pessoalmente · caso no jurídico"
            rows={3}
          />
        </div>

        <Button
          disabled={saving || !reason.trim()}
          onClick={async () => {
            setSaving(true);
            try {
              const res = await setDebtorPaused(debtor.contactId!, true, reason.trim());
              if (!res.ok) {
                toast.error(res.error ?? 'Não foi possível pausar.');
                return;
              }
              toast.success(`${debtor.name} saiu da régua.`);
              onClose();
              onSaved();
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <BellOff className="mr-1.5 h-4 w-4" />}
          Tirar da régua
        </Button>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 🧾 Fase 5 — o portão. Mostra o quanto falta para a régua poder operar
 * sozinha, com o motivo em português, e só libera o botão quando o histórico
 * cumpre o critério. Recolher a autonomia, ao contrário, é sempre imediato:
 * tirar poder da IA nunca pode ter atrito.
 */
function PromotionPanel({ promo, onChanged }: { promo: PromotionView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const { verdict } = promo;
  const s = verdict.stats;

  return (
    <div className={cn('rounded-md border bg-card px-3.5 py-3', promo.isAuto && 'border-emerald-600/40')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Bot className="h-4 w-4 text-muted-foreground" />
        <div className="flex-1">
          <p className="font-medium">
            {promo.isAuto ? 'A régua está enviando sozinha' : 'Envio automático'}
            <span className="ml-1.5 text-sm font-normal text-muted-foreground">
              · {promo.isAuto ? 'cada envio ainda aparece no histórico' : 'hoje toda cobrança espera sua aprovação'}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">{promo.headline}</p>
        </div>

        {promo.isAuto ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await setCollectionsAutonomy(false);
                if (!res.ok) toast.error(res.error ?? 'Não foi possível voltar.');
                else toast.success('Voltou a esperar sua aprovação.');
                onChanged();
              } finally {
                setBusy(false);
              }
            }}
          >
            Voltar a aprovar
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy || !verdict.ready}
            title={verdict.ready ? undefined : verdict.blockers[0]?.label}
            onClick={async () => {
              if (!confirm('Liberar a régua para enviar sozinha? Você continua vendo tudo no histórico, e pode voltar a aprovar a qualquer momento.'))
                return;
              setBusy(true);
              try {
                const res = await setCollectionsAutonomy(true);
                if (!res.ok) toast.error(res.error ?? 'Não foi possível liberar.');
                else toast.success('Régua liberada. Ela envia sozinha, dentro do teto e da janela configurados.');
                onChanged();
              } finally {
                setBusy(false);
              }
            }}
          >
            Liberar envio automático
          </Button>
        )}
      </div>

      {!promo.isAuto && (
        <div className="mt-2.5 flex flex-col gap-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full', verdict.ready ? 'bg-emerald-600' : 'bg-primary')}
              style={{ width: `${Math.round(verdict.progress * 100)}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {s.decisions} {s.decisions === 1 ? 'decisão' : 'decisões'} sua{s.decisions === 1 ? '' : 's'} até agora ·{' '}
            {s.cleanApprovals} aprovadas sem editar · {s.edited} editadas · {s.rejected} recusadas
            {s.badOutcomes ? ` · ${s.badOutcomes} marcadas como erradas` : ''} · {s.spanDays}{' '}
            {s.spanDays === 1 ? 'dia' : 'dias'} de uso
          </p>
          {verdict.blockers.length > 1 && (
            <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              {verdict.blockers.slice(1).map((b) => (
                <li key={b.code}>· {b.label}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
