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
  Check,
  ExternalLink,
  Eye,
  Link2,
  Link2Off,
  Loader2,
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
  UserPlus,
} from 'lucide-react';

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
  createChargeManual,
  createContactForDebtor,
  createContactsForPendingDebtors,
  linkDebtorToContact,
  listCollectionChannels,
  type CollectionChannelOption,
  listConnections,
  removeConnection,
  saveConnection,
  searchContactsForCharge,
  runCollectionsNow,
  saveCollectionsSettings,
  setCollectionsAutonomy,
  setDebtorPaused,
  syncNow,
  unlinkDebtor,
  type ConnectionView,
  type ContactOption,
  type PromotionView,
  type WalletDebtor,
  type WalletSummary,
} from '@/app/(dashboard)/cobrancas/actions';
import { CHARGEABLE_STATUSES, type CollectionsSettings } from '@/lib/collections/rules';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

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

  const debtors = useMemo(() => {
    const all = wallet?.debtors ?? [];
    return onlyPending ? all.filter((d) => !d.contactId) : all;
  }, [wallet, onlyPending]);

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
      <div className="flex items-start gap-2.5 rounded-md border border-emerald-600/30 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
        <Eye className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          <strong>Nenhuma cobrança sai sem você aprovar.</strong> A régua monta as mensagens e deixa em{' '}
          <a href="/aprovacoes" className="font-medium underline underline-offset-2">Precisa de você</a>, onde dá para ler,
          editar e mandar — ou recusar. Antes de cada envio o sistema confere de novo se a parcela continua em aberto.
        </p>
      </div>

      <ConnectionsPanel conns={conns} onChanged={load} onSync={(id) => void handleSyncOne(id)} />

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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Devedores" value={String(wallet?.debtors.length ?? 0)} />
            <Stat label="Cobranças" value={String(wallet?.totalCharges ?? 0)} />
            <Stat label="Total em aberto" value={brl(wallet?.totalValue ?? 0)} wide />
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

          <div className="flex flex-col gap-2.5">
            {debtors.map((d) => (
              <DebtorCard key={d.key} debtor={d} onLink={() => setLinkFor(d)} onUnlink={load} onPause={() => setPauseFor(d)} onChanged={load} />
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

function Stat({ label, value, tone, wide }: { label: string; value: string; tone?: 'warn'; wide?: boolean }) {
  return (
    <div className="rounded-md border bg-card px-3.5 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-0.5 font-semibold tabular-nums',
          wide ? 'text-lg' : 'text-xl',
          tone === 'warn' && 'text-amber-600 dark:text-amber-500',
        )}
      >
        {value}
      </p>
    </div>
  );
}

function DebtorCard({
  debtor,
  onLink,
  onUnlink,
  onPause,
  onChanged,
}: {
  debtor: WalletDebtor;
  onLink: () => void;
  onUnlink: () => void;
  onPause: () => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const late = lateLabel(debtor.oldestDaysLate);

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

        <p className="font-semibold tabular-nums">{brl(debtor.total)}</p>

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
              <Button size="sm" variant="ghost" onClick={onPause} title="Nunca cobrar este devedor pela régua">
                <BellOff className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
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
}: {
  conns: ConnectionView[];
  onChanged: () => void;
  onSync: (id: string) => void;
}) {
  if (!conns.length) return null;

  return (
    <div className="flex flex-col gap-2">
      {conns.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border bg-card px-3.5 py-2.5 text-sm">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{c.label}</span>
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
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ url: string; sentVia: string | null; sendError: string | null; reused: boolean } | null>(null);

  const valueOk = parseValue(valueRaw) != null;
  const dueOk = parseDueDate(dueDate) != null;
  const canSubmit = !!contactId && valueOk && dueOk && description.trim().length >= 3 && !busy;

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
            <p className="font-medium">{done.reused ? 'Já existia uma cobrança igual aberta, criada há pouco — reaproveitei o link.' : 'Cobrança criada.'}</p>
            {done.sentVia && <p>Link enviado por {done.sentVia}.</p>}
            {done.sendError && <p className="text-amber-700 dark:text-amber-400">O link não foi enviado ({done.sendError}). Mande você:</p>}
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

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nc-value">Valor (R$)</Label>
                <Input id="nc-value" inputMode="decimal" placeholder="125,00" value={valueRaw} onChange={(e) => setValueRaw(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nc-due">Vencimento</Label>
                <Input id="nc-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nc-desc">Descrição (vai no boleto/Pix)</Label>
              <Input id="nc-desc" placeholder="Ex.: Botijão P-13 · pedido 1234" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>

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
                    });
                    if (!res.ok) {
                      toast.error(res.error ?? 'Não foi possível gerar a cobrança.');
                      return;
                    }
                    const d = res.data!;
                    setDone({ url: d.invoiceUrl, sentVia: d.sentVia, sendError: d.sendError, reused: d.reused });
                    toast.success(d.sentVia ? `Cobrança gerada e link enviado por ${d.sentVia}.` : 'Cobrança gerada.');
                    onCreated();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Receipt className="mr-1.5 h-3.5 w-3.5" />}
                Gerar cobrança
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
          <DialogTitle>Ligar a um contato do CRM</DialogTitle>
          <DialogDescription>
            {debtor.name} · {brl(debtor.total)} em {debtor.charges.length === 1 ? '1 cobrança' : `${debtor.charges.length} cobranças`}
            {debtor.phone ? ` · ${debtor.phone}` : ''}
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
  const dirty = JSON.stringify(draft) !== JSON.stringify(rule);

  useEffect(() => setDraft(rule), [rule]);
  useEffect(() => {
    if (open && chans === null) {
      void listCollectionChannels()
        .then(setChans)
        .catch(() => setChans([]));
    }
  }, [open, chans]);

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
              ? `A cada ${rule.intervalDays} ${rule.intervalDays === 1 ? 'dia' : 'dias'}, das ${rule.startHour}h às ${rule.endHour}h${rule.weekdaysOnly ? ' em dias úteis' : ''}, no máximo ${rule.dailyCap} por dia. Para depois de ${rule.maxTouches} toques sem resposta.`
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
                `Ligar a régua? Ela vai montar as cobranças a cada ${rule.intervalDays} dias e deixar em "Precisa de você" para você aprovar. Nenhuma mensagem sai sozinha.`,
              )
            )
              return;
            const ok = await persist({ enabled: ligando });
            if (ok) toast.success(ligando ? 'Régua ligada. Nada sai sem sua aprovação.' : 'Régua desligada — ninguém será cobrado.');
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
          </div>

          <div className="flex flex-wrap items-end gap-6">
            {num('startHour', 'Começa às', 'Hora de início, no fuso da conta.', 0, 23)}
            {num('endHour', 'Termina às', 'Hora de término.', 1, 24)}
            <label className="flex items-center gap-2 pb-6 text-sm">
              <input
                type="checkbox"
                checked={draft.weekdaysOnly}
                onChange={(e) => setDraft({ ...draft, weekdaysOnly: e.target.checked })}
              />
              Só em dias úteis
            </label>
          </div>

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
  if (d.paused) return 'Fora da régua: marcado como "não cobrar".';
  if (d.snoozeUntil && new Date(d.snoozeUntil).getTime() > Date.now()) {
    return `Prometeu pagar em ${new Date(d.snoozeUntil).toLocaleDateString('pt-BR')} — a régua dorme até lá.`;
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
