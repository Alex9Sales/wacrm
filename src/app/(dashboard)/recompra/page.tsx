"use client";

// ============================================================
// 📡 "Chamar de volta" (CDL Fase 7) — quem re-engajar hoje. Agrupa os sinais
// de recompra (atrasada / na hora / sumiram / VIP) com ação de 1 clique.
// ============================================================

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import {
  Repeat,
  AlertTriangle,
  Clock,
  Moon,
  Star,
  MessageSquare,
  Loader2,
  RefreshCw,
  Check,
  Sparkles,
  X,
} from "lucide-react";
import {
  getRepurchaseBoard,
  sendReactivation,
  listReactivationChannels,
  listPendingRequests,
  approveRequest,
  rejectRequest,
  type RepurchaseRow,
  type PendingRequestRow,
} from "./actions";
import { toast } from "sonner";
import { greeting } from "@/lib/cdl/names";

/** Rascunho de reativação sugerido (o humano edita/aprova antes de enviar). */
function draftFor(row: RepurchaseRow): string {
  const p = row.payload as Record<string, unknown>;
  const oi = greeting(row.name);
  const prod = p.product ? String(p.product) : "seu pedido";
  if (row.signalType === "inactive")
    return `${oi} Sumiu, hein 😄 Faz um tempo que não passa aqui. Tá precisando de ${prod}? Consigo te atender rapidinho.`;
  if (row.signalType === "repurchase_overdue")
    return `${oi} 😊 Vi que já faz ${p.days_since ?? "uns"} dias do seu último ${prod}. Quer que eu já separe pra você?`;
  return `${oi} Passando pra ver se tá na hora de repor o ${prod}. Quer que eu já deixe separado? 😊`;
}

const CAN_REACTIVATE = new Set([
  "repurchase_overdue",
  "repurchase_due",
  "inactive",
]);

type GroupKey = "repurchase_overdue" | "repurchase_due" | "inactive" | "high_value";

const GROUPS: {
  key: GroupKey;
  label: string;
  desc: string;
  icon: typeof Clock;
  tone: string; // classes p/ o "chip" da seção
  bar: string;
}[] = [
  {
    key: "repurchase_overdue",
    label: "Recompra atrasada",
    desc: "Já passou da hora — o risco de comprarem em outro lugar é agora.",
    icon: AlertTriangle,
    tone: "bg-rose-500/12 text-rose-600 dark:text-rose-400",
    bar: "bg-rose-500",
  },
  {
    key: "repurchase_due",
    label: "Na hora de comprar",
    desc: "Chegou o momento da próxima compra — um empurrãozinho fecha.",
    icon: Clock,
    tone: "bg-amber-500/12 text-amber-600 dark:text-amber-400",
    bar: "bg-amber-500",
  },
  {
    key: "inactive",
    label: "Sumiram",
    desc: "Faz tempo que não compram — vale uma reativação.",
    icon: Moon,
    tone: "bg-slate-500/12 text-slate-600 dark:text-slate-300",
    bar: "bg-slate-400",
  },
  {
    key: "high_value",
    label: "Clientes VIP",
    desc: "Seus melhores clientes — cuide bem pra não perder.",
    icon: Star,
    tone: "bg-primary/12 text-primary",
    bar: "bg-primary",
  },
];

function brl(v: unknown): string {
  const n = parseFloat(String(v ?? ""));
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function detail(row: RepurchaseRow): string {
  const p = row.payload as Record<string, unknown>;
  if (row.signalType === "high_value") {
    const parts: string[] = [];
    if (p.transaction_count) parts.push(`${p.transaction_count} compras`);
    if (p.total_revenue) parts.push(`${brl(p.total_revenue)} no total`);
    return parts.join(" · ");
  }
  const parts: string[] = [];
  if (p.days_since != null) parts.push(`${p.days_since} dias sem comprar`);
  if (p.avg_days != null) parts.push(`compra a cada ${p.avg_days}d`);
  if (p.product) parts.push(`última: ${p.product}`);
  if (p.last_amount != null && Number(p.last_amount) > 0)
    parts.push(brl(p.last_amount));
  return parts.join(" · ");
}

export default function RecompraPage() {
  const [rows, setRows] = useState<RepurchaseRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<Set<string>>(new Set());
  // 📞 Linhas de WhatsApp — pra reativar quem ainda NÃO tem conversa (importado).
  const [waChannels, setWaChannels] = useState<{ id: string; name: string }[]>([]);
  const [sendChannel, setSendChannel] = useState("");

  // 🎛️ Fila de aprovação (Fase 8): rascunhos da IA esperando 1 clique.
  const [pending, setPending] = useState<PendingRequestRow[]>([]);
  const [pendingText, setPendingText] = useState<Record<string, string>>({});
  const [pendingBusy, setPendingBusy] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    getRepurchaseBoard()
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
    listPendingRequests()
      .then((p) => {
        setPending(p);
        setPendingText((prev) => {
          const next = { ...prev };
          for (const r of p) if (next[r.id] === undefined) next[r.id] = r.suggestedText;
          return next;
        });
      })
      .catch(() => setPending([]));
    listReactivationChannels()
      .then((c) => {
        setWaChannels(c);
        setSendChannel((prev) => prev || c[0]?.id || "");
      })
      .catch(() => setWaChannels([]));
  };
  useEffect(() => {
    load();
  }, []);

  async function handleApprove(r: PendingRequestRow) {
    setPendingBusy(r.id);
    const res = await approveRequest({ id: r.id, text: pendingText[r.id] ?? r.suggestedText });
    setPendingBusy(null);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success("Aprovado e enviado 👍");
    setPending((prev) => prev.filter((x) => x.id !== r.id));
  }

  async function handleReject(r: PendingRequestRow) {
    setPendingBusy(r.id);
    const res = await rejectRequest({ id: r.id });
    setPendingBusy(null);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    setPending((prev) => prev.filter((x) => x.id !== r.id));
  }

  const rowKey = (r: RepurchaseRow) => r.contactId + r.signalType;

  function openDraft(r: RepurchaseRow) {
    setDraftKey(rowKey(r));
    setDraftText(draftFor(r));
  }

  async function handleSend(r: RepurchaseRow) {
    // Sem conversa (importado) → manda pela linha escolhida (cria a conversa).
    const channelId = r.conversationId ? undefined : sendChannel || waChannels[0]?.id;
    if (!r.conversationId && !channelId) {
      toast.error("Nenhuma linha de WhatsApp disponível.");
      return;
    }
    setSending(true);
    const res = await sendReactivation({
      conversationId: r.conversationId ?? undefined,
      contactId: r.contactId,
      signalType: r.signalType,
      text: draftText,
      channelId,
    });
    setSending(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success("Mensagem enviada 👍");
    setSent((prev) => new Set(prev).add(rowKey(r)));
    setDraftKey(null);
  }

  const grouped = useMemo(() => {
    const g: Record<string, RepurchaseRow[]> = {};
    for (const r of rows ?? []) (g[r.signalType] ??= []).push(r);
    return g;
  }, [rows]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
            <Repeat className="size-6 text-primary" /> Chamar de volta
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Quem re-engajar hoje — a IA olha o histórico e aponta a recompra
            atrasada, quem está na hora de comprar e quem sumiu.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Recalcular agora"
        >
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          Atualizar
        </button>
      </div>

      {/* 🎛️ Fila de aprovação — rascunhos da IA (agente em modo "Aprova") */}
      {pending.length > 0 && (
        <section className="mb-6 rounded-xl border border-primary/30 bg-primary/[0.04] p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/12 px-2.5 py-1 text-sm font-medium text-primary">
              <Sparkles className="size-4" /> A IA sugeriu — aprove pra enviar
            </span>
            <span className="text-sm text-muted-foreground">{pending.length}</span>
          </div>
          <ul className="space-y-3">
            {pending.map((r) => {
              const busy = pendingBusy === r.id;
              return (
                <li key={r.id} className="rounded-lg border border-border bg-card p-3">
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-foreground">
                        {r.name || r.phone || "Sem nome"}
                      </div>
                      {r.reason && (
                        <div className="truncate text-xs text-muted-foreground">
                          {r.reason}
                        </div>
                      )}
                    </div>
                    {r.conversationId && (
                      <Link
                        href={`/inbox?c=${r.conversationId}`}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                      >
                        <MessageSquare className="size-3.5" /> Abrir
                      </Link>
                    )}
                  </div>
                  <textarea
                    value={pendingText[r.id] ?? r.suggestedText}
                    onChange={(e) =>
                      setPendingText((prev) => ({ ...prev, [r.id]: e.target.value }))
                    }
                    rows={2}
                    className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <button
                      onClick={() => void handleReject(r)}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
                    >
                      <X className="size-4" /> Recusar
                    </button>
                    <button
                      onClick={() => void handleApprove(r)}
                      disabled={busy || !(pendingText[r.id] ?? r.suggestedText).trim()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                    >
                      {busy ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Check className="size-4" />
                      )}
                      Aprovar e enviar
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Resumo por grupo */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {GROUPS.map((grp) => (
          <a
            key={grp.key}
            href={`#${grp.key}`}
            className="rounded-xl border border-border bg-card p-3 transition-colors hover:border-primary/40"
          >
            <div
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${grp.tone}`}
            >
              <grp.icon className="size-3.5" /> {grp.label}
            </div>
            <div className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
              {(grouped[grp.key] ?? []).length}
            </div>
          </a>
        ))}
      </div>

      {loading && rows === null ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" /> Analisando o histórico…
        </div>
      ) : (rows ?? []).length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-16 text-center">
          <p className="text-foreground">Nenhum sinal ainda.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Assim que houver histórico de compras (importado ou de vendas
            fechadas), a lista de recompra aparece aqui.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {GROUPS.map((grp) => {
            const list = grouped[grp.key] ?? [];
            if (list.length === 0) return null;
            return (
              <section key={grp.key} id={grp.key} className="scroll-mt-6">
                <div className="mb-3 flex items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-medium ${grp.tone}`}
                  >
                    <grp.icon className="size-4" /> {grp.label}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {list.length}
                  </span>
                </div>
                <p className="mb-3 text-xs text-muted-foreground">{grp.desc}</p>
                <ul className="overflow-hidden rounded-xl border border-border">
                  {list.map((row, i) => {
                    const key = row.contactId + row.signalType;
                    const isSent = sent.has(key);
                    const isDrafting = draftKey === key;
                    // Reativar aparece pra quem tem conversa OU (importado) tem
                    // telefone + há linha de WhatsApp pra criar a conversa.
                    const canReactivate =
                      CAN_REACTIVATE.has(row.signalType) &&
                      (!!row.conversationId ||
                        (!!row.phone && waChannels.length > 0));
                    return (
                      <li
                        key={key}
                        className={`bg-card px-4 py-3 ${
                          i > 0 ? "border-t border-border" : ""
                        } ${isSent ? "opacity-55" : ""}`}
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className={`h-9 w-1 shrink-0 rounded-full ${grp.bar}`}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium text-foreground">
                              {row.name || row.phone || "Sem nome"}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {detail(row)}
                            </div>
                          </div>
                          {isSent ? (
                            <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                              <Check className="size-4" /> Enviado
                            </span>
                          ) : (
                            <div className="flex shrink-0 items-center gap-2">
                              {canReactivate && !isDrafting && (
                                <button
                                  onClick={() => openDraft(row)}
                                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                                >
                                  <Repeat className="size-4" /> Reativar
                                </button>
                              )}
                              {row.conversationId ? (
                                <Link
                                  href={`/inbox?c=${row.conversationId}`}
                                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                                >
                                  <MessageSquare className="size-4" /> Abrir
                                </Link>
                              ) : row.phone ? (
                                <a
                                  href={`https://wa.me/${row.phone.replace(/\D/g, "")}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                                >
                                  <MessageSquare className="size-4" /> WhatsApp
                                </a>
                              ) : null}
                            </div>
                          )}
                        </div>

                        {isDrafting && (
                          <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3">
                            <p className="mb-1.5 text-xs text-muted-foreground">
                              {row.conversationId
                                ? "Sugestão da IA — edite se quiser e envie:"
                                : "Cliente novo por aqui — a IA abre a conversa. Edite se quiser e envie:"}
                            </p>
                            <textarea
                              value={draftText}
                              onChange={(e) => setDraftText(e.target.value)}
                              rows={3}
                              className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                            />
                            {!row.conversationId && waChannels.length > 0 && (
                              <div className="mt-2 flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">
                                  Enviar pela linha:
                                </span>
                                <select
                                  value={sendChannel}
                                  onChange={(e) => setSendChannel(e.target.value)}
                                  className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                                >
                                  {waChannels.map((c) => (
                                    <option key={c.id} value={c.id}>
                                      {c.name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                            <div className="mt-2 flex items-center justify-end gap-2">
                              <button
                                onClick={() => setDraftKey(null)}
                                className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                              >
                                Cancelar
                              </button>
                              <button
                                onClick={() => void handleSend(row)}
                                disabled={sending || !draftText.trim()}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                              >
                                {sending ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <MessageSquare className="size-4" />
                                )}
                                Enviar agora
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
