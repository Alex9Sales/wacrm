'use client';

// ============================================================
// 🔔 A vencer sem contato no CRM (16/09, Speed Gás e Água / GoLink).
//
// O lembrete antes do vencimento não sai para cliente do Asaas que não casou
// com nenhum contato — e isso só aparecia no log do worker. Este painel mostra
// quem é, e resolve um por um: "Ligar a um contato" ou "Criar contato". O CRM
// nunca cria contato nem vínculo sozinho. Todo clique tem "Desfazer": uma
// ligação errada numa parcela paga em dia nunca apareceria em tela nenhuma.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CalendarClock, ExternalLink, Link2, Loader2, RefreshCw, Search, TriangleAlert, UserPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { isStaleActionError, reloadForStaleAction } from '@/lib/stale-action';
import {
  dueInText,
  reminderAfterLinkText,
  undoResultText,
  unmatchedReasonText,
  type UpcomingUndoKind,
} from '@/lib/collections/upcoming-unmatched';
import {
  createContactForUpcoming,
  linkUpcomingCustomer,
  searchContactsForCharge,
  unlinkUpcomingCustomer,
  type ContactOption,
  type UpcomingUndoInput,
  type UpcomingUnmatchedCard,
  type UpcomingUnmatchedView,
} from '@/app/(dashboard)/cobrancas/actions';

type UndoFn = (card: UpcomingUnmatchedCard, input: UpcomingUndoInput, kind: UpcomingUndoKind, contactName: string) => Promise<void>;

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** "5512997075373" → "(12) 99707-5373" (o mesmo da carteira). O que não for número BR sai como veio. */
function fmtPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  const local = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d;
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  return raw;
}

/** Mesmo número pelos 8 últimos dígitos (com/sem 55 e 9º dígito). */
function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = (a ?? '').replace(/\D/g, '').slice(-8);
  const tb = (b ?? '').replace(/\D/g, '').slice(-8);
  return ta.length === 8 && ta === tb;
}

const dayMonth = (ymd: string | null) => (ymd ? ymd.slice(5, 10).split('-').reverse().join('/') : '—');

function checkedAtText(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dia = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `conferido em ${dia} às ${hora}`;
}

/** Erro de aba velha (deploy no meio) recarrega; o resto vira aviso — nunca silêncio. */
function handleActionError(err: unknown, fallback: string) {
  if (isStaleActionError(err)) {
    reloadForStaleAction();
    return;
  }
  toast.error(fallback);
}

export function UpcomingUnmatchedPanel({
  view,
  error,
  connFilter,
  onChanged,
}: {
  view: UpcomingUnmatchedView | null;
  /** A leitura falhou: mostra o erro — nunca uma lista vazia. */
  error: boolean;
  /** Conta do Asaas escolhida no topo (null = todas). */
  connFilter: string | null;
  onChanged: () => void;
}) {
  const [linkFor, setLinkFor] = useState<UpcomingUnmatchedCard | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const cards = useMemo(
    () => (view?.cards ?? []).filter((c) => !connFilter || c.connectionId === connFilter),
    [view, connFilter],
  );

  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-2.5 rounded-md border border-amber-500/40 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
        <TriangleAlert className="h-4 w-4 shrink-0" />
        <p className="flex-1">Não deu para carregar os clientes a vencer sem contato. Isso não quer dizer que não há ninguém — só que a lista não foi lida agora.</p>
        <Button size="sm" variant="outline" onClick={onChanged}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Tentar de novo
        </Button>
      </div>
    );
  }
  if (!view?.enabled || !cards.length) return null;

  const keyOf = (c: UpcomingUnmatchedCard) => `${c.connectionId}:${c.customerId}`;
  const ruleEnabled = view.ruleEnabled;

  const undo: UndoFn = async (card, input, kind, contactName) => {
    try {
      const back = await unlinkUpcomingCustomer(card.connectionId, card.customerId, input);
      if (!back.ok) {
        toast.error(back.error ?? 'Não foi possível desfazer.');
        return;
      }
      const contactRemoved = !!back.data?.contactRemoved;
      const text = undoResultText({ kind, contactRemoved, contactName, ruleEnabled });
      // Contato que continua casando sozinho não é "desfeito" de verdade: aviso, não sucesso.
      if (kind === 'linked' || contactRemoved) toast.success(text);
      else toast.warning(text, { duration: 15_000 });
      onChanged();
    } catch (err) {
      handleActionError(err, 'Não foi possível desfazer. Tente de novo.');
    }
  };

  async function createFor(card: UpcomingUnmatchedCard) {
    setBusy(keyOf(card));
    try {
      const res = await createContactForUpcoming(card.connectionId, card.customerId);
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Não foi possível criar o contato.');
        onChanged();
        return;
      }
      const d = res.data;
      // O Desfazer leva o estado de antes das cobranças e, quando o contato
      // nasceu agora, o id dele — para apagá-lo se nada depender dele (16/09).
      const input: UpcomingUndoInput = {
        contactId: d.contactId,
        previousContactId: d.previousContactId,
        restore: d.restore,
        createdContactId: d.created ? d.contactId : null,
      };
      toast.success(
        d.created
          ? `Contato criado e ligado. ${reminderAfterLinkText(ruleEnabled)}`
          : `Já existia o contato "${d.contactName}" com esse telefone ou e-mail — o cliente foi ligado a ele.`,
        {
          duration: 12_000,
          action: { label: 'Desfazer', onClick: () => void undo(card, input, d.created ? 'created' : 'existing', d.contactName) },
        },
      );
      onChanged();
    } catch (err) {
      handleActionError(err, 'Não foi possível criar o contato. Tente de novo.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <details open className="rounded-md border border-amber-500/40 bg-amber-50/60 px-3.5 py-3 text-sm dark:bg-amber-950/30">
      <summary className="flex cursor-pointer items-center gap-2 font-medium text-amber-900 dark:text-amber-200">
        <CalendarClock className="h-4 w-4 shrink-0" />
        A vencer sem contato no CRM ({cards.length})
      </summary>
      <p className="mt-2 text-xs text-amber-900/90 dark:text-amber-200/90">
        O lembrete antes do vencimento não sai para estes clientes do Asaas: nenhum contato do CRM tem o telefone, o e-mail ou o CPF/CNPJ
        deles — ou mais de um contato tem o mesmo telefone, e-mail ou CPF/CNPJ. Ligue ao contato certo ou crie um — o CRM nunca cria contato
        sozinho. Quando a parcela vence, o cliente passa para a carteira acima.
      </p>
      {!ruleEnabled && (
        <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-amber-900 dark:text-amber-200">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            A régua está desligada: esta lista parou na última leitura{view.checkedAt ? ` (${checkedAtText(view.checkedAt)})` : ''} e pode
            ter quem já pagou. Ligar um cliente aqui vale para as próximas parcelas, mas o lembrete só sai quando a régua for religada.
          </span>
        </p>
      )}

      <ul className="mt-3 flex flex-col gap-2">
        {cards.map((c) => {
          const k = keyOf(c);
          const createBlocked =
            c.reason === 'ambiguous'
              ? 'Mais de um contato tem o mesmo telefone, e-mail ou CPF/CNPJ — use "Ligar a um contato" e escolha o certo'
              : !c.canCreate
                ? 'Sem telefone válido nem e-mail no Asaas'
                : null;
          return (
            <li key={k} className="rounded-md border bg-card px-3 py-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {c.name} <span className="text-xs font-normal text-muted-foreground">· {c.connectionLabel}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {c.phone || c.email
                      ? [c.phone ? fmtPhone(c.phone) : '', c.email ?? ''].filter(Boolean).join(' · ')
                      : 'sem telefone nem e-mail no Asaas'}
                  </p>
                </div>
                <p className="font-semibold tabular-nums">{brl(c.total)}</p>
              </div>

              <ul className="mt-1.5 flex flex-col gap-0.5 text-xs">
                {c.payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="tabular-nums font-medium">{brl(p.value)}</span>
                    <span className="text-muted-foreground">
                      venc. {dayMonth(p.dueDate)} ({dueInText(p.dueDate, view.todayKey)})
                    </span>
                    {p.description && <span className="text-muted-foreground">· {p.description}</span>}
                    {p.invoiceUrl && (
                      <a
                        href={p.invoiceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
                      >
                        ver cobrança <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </li>
                ))}
              </ul>

              <p className="mt-1.5 text-xs text-amber-800 dark:text-amber-300">{unmatchedReasonText(c.reason)}.</p>
              {c.sameDocumentOthers > 0 && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Há outro cadastro com o mesmo CPF/CNPJ nesta lista (na outra conta do Asaas, por exemplo). Ligar este não liga o outro — confira e
                  ligue cada um.
                </p>
              )}

              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy === k} onClick={() => setLinkFor(c)}>
                  <Link2 className="mr-1.5 h-3.5 w-3.5" /> Ligar a um contato
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === k || !!createBlocked}
                  title={createBlocked ?? 'Cria o contato com nome, telefone e e-mail do Asaas e liga este cliente a ele'}
                  onClick={() => void createFor(c)}
                >
                  {busy === k ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <UserPlus className="mr-1.5 h-3.5 w-3.5" />}
                  Criar contato
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-2.5 text-[11px] text-muted-foreground">
        Vencem nos próximos {view.daysBefore} {view.daysBefore === 1 ? 'dia' : 'dias'}
        {view.checkedAt ? ` · ${checkedAtText(view.checkedAt)}` : ''} · a lista é refeita a cada rodada da régua, no horário de cobrança.
      </p>

      {linkFor && (
        <LinkUpcomingDialog
          key={keyOf(linkFor)}
          card={linkFor}
          ruleEnabled={ruleEnabled}
          onClose={() => setLinkFor(null)}
          onLinked={onChanged}
          onUndo={undo}
        />
      )}
    </details>
  );
}

function LinkUpcomingDialog({
  card,
  ruleEnabled,
  onClose,
  onLinked,
  onUndo,
}: {
  card: UpcomingUnmatchedCard;
  ruleEnabled: boolean;
  onClose: () => void;
  onLinked: () => void;
  onUndo: UndoFn;
}) {
  // Começa pelo nome do Asaas; quem tem o MESMO telefone vem primeiro de
  // qualquer jeito (searchContactsForCharge, 16/09 L&M Vidros × "LM Vidros").
  // O painel monta um diálogo novo por cliente (key), então o estado nasce certo.
  const [q, setQ] = useState(card.name === 'Sem nome' ? '' : card.name);
  const [results, setResults] = useState<ContactOption[]>([]);
  const [searchFailed, setSearchFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const r = await searchContactsForCharge(q, card.phone);
        if (alive) {
          setResults(r);
          setSearchFailed(false);
        }
      } catch {
        // Erro de busca não é "nenhum contato encontrado".
        if (alive) {
          setResults([]);
          setSearchFailed(true);
        }
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, card]);

  const n = card.payments.length;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ligar a um contato do CRM</DialogTitle>
          <DialogDescription>
            {card.name} · {brl(card.total)} a vencer em {n === 1 ? '1 parcela' : `${n} parcelas`}
            {card.phone ? ` · ${fmtPhone(card.phone)}` : ''} · {card.connectionLabel}. As próximas parcelas deste cliente também vão para o
            contato que você escolher.
          </DialogDescription>
        </DialogHeader>

        {card.reason === 'ambiguous' && (
          <p className="rounded-md border border-amber-500/40 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            Mais de um contato tem o mesmo telefone, e-mail ou CPF/CNPJ deste cliente. Confira qual é o certo antes de ligar — busque também
            pelo e-mail.
          </p>
        )}

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
                try {
                  const res = await linkUpcomingCustomer(card.connectionId, card.customerId, c.id);
                  if (!res.ok || !res.data) {
                    toast.error(res.error ?? 'Não foi possível ligar.');
                    return;
                  }
                  const d = res.data;
                  const input: UpcomingUndoInput = {
                    contactId: c.id,
                    previousContactId: d.previousContactId,
                    restore: d.restore,
                    createdContactId: null,
                  };
                  toast.success(`Ligado a ${d.contactName}. ${reminderAfterLinkText(ruleEnabled)}`, {
                    duration: 12_000,
                    action: { label: 'Desfazer', onClick: () => void onUndo(card, input, 'linked', d.contactName) },
                  });
                  // O lembrete vai para o número da FICHA, não para o do Asaas.
                  if (!d.contactPhone) {
                    toast.warning(`A ficha de ${d.contactName} não tem telefone — o lembrete não sai por WhatsApp.`, { duration: 10_000 });
                  } else if (card.phone && !samePhone(d.contactPhone, card.phone)) {
                    toast.warning(`A ficha de ${d.contactName} tem outro telefone — o lembrete vai para o número da ficha, não para o do Asaas.`, {
                      duration: 10_000,
                    });
                  }
                  onClose();
                  onLinked();
                } catch (err) {
                  handleActionError(err, 'Não foi possível ligar. Tente de novo.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <span className="font-medium">{c.name}</span>
              {samePhone(c.phone, card.phone) && (
                <span className="ml-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">· mesmo telefone do Asaas</span>
              )}
              <span className="block text-xs text-muted-foreground">
                {c.phone ? fmtPhone(c.phone) : 'sem telefone'}
                {c.email ? ` · ${c.email}` : ''}
              </span>
            </button>
          ))}
          {!results.length && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {searchFailed
                ? 'Não deu para buscar agora. Tente de novo.'
                : q.trim().length < 2 && !card.phone
                  ? 'Digite ao menos 2 letras.'
                  : 'Nenhum contato encontrado com esse termo.'}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
