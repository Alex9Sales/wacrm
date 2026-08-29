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
} from "lucide-react";
import { getRepurchaseBoard, type RepurchaseRow } from "./actions";

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

  const load = () => {
    setLoading(true);
    getRepurchaseBoard()
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, []);

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
                  {list.map((row, i) => (
                    <li
                      key={row.contactId + row.signalType}
                      className={`flex items-center gap-3 bg-card px-4 py-3 ${
                        i > 0 ? "border-t border-border" : ""
                      }`}
                    >
                      <span className={`h-9 w-1 shrink-0 rounded-full ${grp.bar}`} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-foreground">
                          {row.name || row.phone || "Sem nome"}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {detail(row)}
                        </div>
                      </div>
                      {row.conversationId ? (
                        <Link
                          href={`/inbox?c=${row.conversationId}`}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                        >
                          <MessageSquare className="size-4" /> Abrir
                        </Link>
                      ) : row.phone ? (
                        <a
                          href={`https://wa.me/${row.phone.replace(/\D/g, "")}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                        >
                          <MessageSquare className="size-4" /> WhatsApp
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
