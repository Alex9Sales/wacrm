'use client';

// ============================================================
// 🔔 A vencer sem contato no CRM (16/09, Veloz Gás e Água / GoLink).
//
// O lembrete antes do vencimento não sai para cliente do Asaas que não casou
// com nenhum contato — e isso só aparecia no log do worker. Este painel mostra
// quem é, e resolve um por um: "Ligar a um contato" ou "Criar contato". O CRM
// nunca cria contato nem vínculo sozinho. Todo clique tem "Desfazer": uma
// ligação errada numa parcela paga em dia nunca apareceria em tela nenhuma.
// Depois que o aviso some, a lista "Ligados nos últimos dias" guarda o
// "Desligar" (revisão 16/09).
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CalendarClock, ExternalLink, Link2, Link2Off, Loader2, RefreshCw, Search, TriangleAlert, UserPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { isStaleActionError, reloadForStaleAction } from '@/lib/stale-action';
import {
  dueInText,
  linkOutcomeTexts,
  RECENT_LINK_EXTRA_DAYS,
  recentLinkName,
  recentUnlinkText,
  undoResultText,
  unmatchedReasonText,
  type LinkDeliveryInfo,
  type UpcomingUndoKind,
} from '@/lib/collections/upcoming-unmatched';
import {
  createContactForUpcoming,
  linkUpcomingCustomer,
  searchContactsForCharge,
  unlinkRecentUpcomingCustomer,
  unlinkUpcomingCustomer,
  type ContactOption,
  type UpcomingRecentLink,
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

/**
 * Aviso de canal depois de ligar/criar. 16/09: a tela prometia o lembrete sem
 * saber se ele sai — o servidor confere como a fila confere (linkOutcomeTexts).
 */
function showDeliveryWarning(warning: string | null, info: LinkDeliveryInfo) {
  if (!warning) return;
  if (info.deliveryError) toast.error(warning, { duration: 15_000 });
  else toast.warning(warning, { duration: 12_000 });
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
  if (!view?.enabled) return null;

  const ruleEnabled = view.ruleEnabled;
  const recent = (view.recentLinks ?? []).filter((l) => !connFilter || l.connectionId === connFilter);
  const recentBlock =
    recent.length || view.recentLinksFailed ? (
      <RecentLinks
        links={recent}
        failed={view.recentLinksFailed}
        daysBefore={view.daysBefore}
        ruleEnabled={ruleEnabled}
        standalone={!cards.length}
        onChanged={onChanged}
      />
    ) : null;
  // Sem cartão, a lista de ligados continua à mão: é o único lugar para
  // desligar um cliente que só tem parcela a vencer.
  if (!cards.length) return recentBlock;

  const keyOf = (c: UpcomingUnmatchedCard) => `${c.connectionId}:${c.customerId}`;

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
      const { reminder, warning } = linkOutcomeTexts(card.name, ruleEnabled, d);
      toast.success(
        [
          d.created
            ? 'Contato criado e ligado.'
            : `Já existia o contato "${d.contactName}" com esse telefone ou e-mail — o cliente foi ligado a ele.`,
          reminder,
        ]
          .filter(Boolean)
          .join(' '),
        {
          duration: 12_000,
          action: { label: 'Desfazer', onClick: () => void undo(card, input, d.created ? 'created' : 'existing', d.contactName) },
        },
      );
      showDeliveryWarning(warning, d);
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

      {recentBlock && <div className="mt-3">{recentBlock}</div>}

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

/** "em 16/09 às 14:02 por Joyce". */
function linkedText(l: UpcomingRecentLink): string {
  const d = new Date(l.linkedAt);
  const quando = Number.isNaN(d.getTime())
    ? ''
    : `em ${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  return [quando, l.linkedByName ? `por ${l.linkedByName}` : ''].filter(Boolean).join(' ');
}

/**
 * "Ligados nos últimos dias" (revisão 16/09). Cliente que só tem parcela A
 * VENCER não aparece na carteira e o cartão some deste painel assim que é
 * ligado: sem esta lista, uma ligação errada só podia ser desfeita nos 12 s do
 * aviso — depois o lembrete saía com o valor e o link de um cliente para o
 * contato errado, e ninguém tinha onde ver.
 */
function RecentLinks({
  links,
  failed,
  daysBefore,
  ruleEnabled,
  standalone,
  onChanged,
}: {
  links: UpcomingRecentLink[];
  /** A lista não carregou: diz na tela, nunca parece "ninguém ligado". */
  failed: boolean;
  daysBefore: number;
  ruleEnabled: boolean;
  /** Sem cartões a vencer: a lista aparece sozinha, com borda própria. */
  standalone: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function unlink(l: UpcomingRecentLink) {
    const key = `${l.connectionId}:${l.customerId}`;
    setBusy(key);
    try {
      // Só o vínculo sai; cliente que já tem cobrança aberta o servidor recusa (desliga na carteira).
      const res = await unlinkRecentUpcomingCustomer(l.connectionId, l.customerId, l.contactId);
      if (!res.ok) {
        toast.error(res.error ?? 'Não foi possível desligar.');
        onChanged();
        return;
      }
      // Revisão 16/09: clique errado aqui não tinha volta — a linha some, o
      // cliente não está na carteira nem no painel até a próxima rodada, e o nome
      // do Asaas ia junto com o vínculo. O Desfazer religa ao mesmo contato.
      toast.success(recentUnlinkText({ customerName: recentLinkName(l.customerName, l.customerId), contactName: l.contactName, ruleEnabled }), {
        duration: 15_000,
        action: { label: 'Desfazer', onClick: () => void relink(l) },
      });
      onChanged();
    } catch (err) {
      handleActionError(err, 'Não foi possível desligar. Tente de novo.');
    } finally {
      setBusy(null);
    }
  }

  async function relink(l: UpcomingRecentLink) {
    try {
      const res = await linkUpcomingCustomer(l.connectionId, l.customerId, l.contactId, l.customerName);
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Não foi possível desfazer.');
        onChanged();
        return;
      }
      const d = res.data;
      const { reminder, warning } = linkOutcomeTexts(recentLinkName(l.customerName, l.customerId), ruleEnabled, d);
      toast.success([`Desfeito: ligado de novo a ${d.contactName}.`, reminder].filter(Boolean).join(' '));
      showDeliveryWarning(warning, d);
      onChanged();
    } catch (err) {
      handleActionError(err, 'Não foi possível desfazer. Tente de novo.');
    }
  }

  return (
    <details
      open={failed}
      className={
        standalone
          ? 'rounded-md border bg-card px-3.5 py-2.5 text-sm'
          : 'rounded-md border bg-card/60 px-3 py-2 text-sm'
      }
    >
      <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Link2 className="h-3.5 w-3.5 shrink-0" /> Ligados nos últimos dias ({links.length})
      </summary>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Clientes do Asaas ligados a um contato nos últimos {daysBefore + RECENT_LINK_EXTRA_DAYS} dias que não têm cobrança aberta na carteira. O
        lembrete antes do vencimento vai para o contato ligado — se a ligação estiver errada, desligue aqui.
      </p>
      {failed && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-red-700 dark:text-red-300">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Não deu para carregar os clientes ligados recentemente — isso não quer dizer que não há nenhum. Atualize a tela para conferir.</span>
        </p>
      )}
      {links.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {links.map((l) => {
            const key = `${l.connectionId}:${l.customerId}`;
            return (
              <li key={key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border px-2.5 py-1.5 text-xs">
                <span className="min-w-0">
                  <span className="font-medium">{recentLinkName(l.customerName, l.customerId)}</span> → {l.contactName}
                  {!l.contactHasPhone && <span className="text-amber-800 dark:text-amber-300"> (ficha sem telefone)</span>}
                  <span className="block text-muted-foreground">
                    {l.connectionLabel}
                    {linkedText(l) ? ` · ligado ${linkedText(l)}` : ''}
                  </span>
                </span>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy !== null} onClick={() => void unlink(l)}>
                  {busy === key ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Link2Off className="mr-1 h-3 w-3" />}
                  Desligar
                </Button>
              </li>
            );
          })}
        </ul>
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
  // qualquer jeito (searchContactsForCharge, 16/09 R&S Vidros × "RS Vidros").
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
                  // O lembrete vai para o número da FICHA, não para o do Asaas —
                  // e só sai pelo canal que o servidor conferiu (16/09).
                  const { reminder, warning } = linkOutcomeTexts(card.name, ruleEnabled, d);
                  toast.success([`Ligado a ${d.contactName}.`, reminder].filter(Boolean).join(' '), {
                    duration: 12_000,
                    action: { label: 'Desfazer', onClick: () => void onUndo(card, input, 'linked', d.contactName) },
                  });
                  showDeliveryWarning(warning, d);
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
