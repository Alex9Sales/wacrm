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
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

import {
  getWallet,
  linkDebtorToContact,
  listConnections,
  removeConnection,
  saveConnection,
  searchContactsForCharge,
  syncNow,
  unlinkDebtor,
  type ConnectionView,
  type ContactOption,
  type WalletDebtor,
  type WalletSummary,
} from '@/app/(dashboard)/cobrancas/actions';

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
  const [onlyPending, setOnlyPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const [w, c] = await Promise.all([getWallet(), listConnections()]);
      setWallet(w);
      setConns(c);
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
        toast.success(
          `${d.total} ${d.total === 1 ? 'cobrança' : 'cobranças'} na carteira` +
            (d.pending ? ` · ${d.pending} sem contato` : '') +
            (d.closed ? ` · ${d.closed} saíram desde a última vez` : ''),
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
            O que está em aberto no Asaas, espelhado aqui dentro.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> Conectar Asaas
          </Button>
          <Button onClick={handleSync} disabled={syncing || !conns.length}>
            {syncing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
            Atualizar
          </Button>
        </div>
      </header>

      {/* Aviso permanente: nesta fase nada é enviado. Não é toast — é contrato. */}
      <div className="flex items-start gap-2.5 rounded-md border border-emerald-600/30 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
        <Eye className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          <strong>Nada é enviado nesta tela.</strong> Ela só lê o Asaas para você conferir os valores e a conta de cada
          cobrança. O envio entra na próxima fase, e mesmo lá começa passando pela sua aprovação.
        </p>
      </div>

      <ConnectionsPanel conns={conns} onChanged={load} onSync={(id) => void handleSyncOne(id)} />

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
            </div>
          )}

          <div className="flex flex-col gap-2.5">
            {debtors.map((d) => (
              <DebtorCard key={d.key} debtor={d} onLink={() => setLinkFor(d)} onUnlink={load} />
            ))}
            {!debtors.length && (
              <p className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
                {onlyPending
                  ? 'Nenhuma pendência de contato — todos os devedores casaram.'
                  : 'Nenhuma cobrança em aberto. Toque em Atualizar para buscar no Asaas.'}
              </p>
            )}
          </div>
        </>
      )}

      <AddConnectionDialog open={addOpen} onOpenChange={setAddOpen} onSaved={load} />
      <LinkContactDialog debtor={linkFor} onClose={() => setLinkFor(null)} onLinked={load} />
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
}: {
  debtor: WalletDebtor;
  onLink: () => void;
  onUnlink: () => void;
}) {
  const [open, setOpen] = useState(false);
  const late = lateLabel(debtor.oldestDaysLate);

  return (
    <div className={cn('rounded-md border bg-card', !debtor.contactId && 'border-amber-500/40')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-3">
        <button type="button" className="flex-1 text-left" onClick={() => setOpen((v) => !v)}>
          <p className="font-medium">{debtor.name}</p>
          <p className="text-xs text-muted-foreground">
            {debtor.charges.length === 1 ? '1 cobrança' : `${debtor.charges.length} cobranças`} ·{' '}
            <span className={late.tone}>{late.text}</span>
            {debtor.phone ? ` · ${debtor.phone}` : ''}
          </p>
        </button>

        <p className="font-semibold tabular-nums">{brl(debtor.total)}</p>

        {debtor.contactId ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            <Check className="h-3 w-3" />
            {debtor.matchedBy === 'manual' ? 'ligado na mão' : 'contato do CRM'}
          </span>
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
      </DialogContent>
    </Dialog>
  );
}
