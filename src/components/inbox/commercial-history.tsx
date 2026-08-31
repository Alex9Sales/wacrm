"use client";

// ============================================================
// 📊 Histórico de compras (CDL Fase 5) — painel na conversa que mostra o que
// a IA sabe do cliente: métricas (nº compras, última, frequência, ticket,
// preferências) + a lista das últimas transações. Alimentado pelo importador
// (Config → Importar → Histórico de vendas) e pelos fatos nativos do CRM.
// ============================================================

import { useEffect, useState, useCallback } from "react";
import {
  ShoppingBag,
  ChevronDown,
  ChevronRight,
  Loader2,
  Sparkles,
} from "lucide-react";
import {
  getContactCommercialProfile,
  type ContactCommercialProfile,
} from "@/app/(dashboard)/contacts/actions";

function money(v: string | null | undefined): string {
  const n = parseFloat(String(v ?? ""));
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("pt-BR");
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

/** "atendimento(s)" p/ serviço, senão "compra(s)". */
function noun(type: string | null | undefined, n: number): string {
  const t = (type ?? "").toLowerCase();
  const service = /servi|consult|atend|procedi|agend|appoint|sess|exam|visit/.test(
    t,
  );
  if (service) return n === 1 ? "atendimento" : "atendimentos";
  if (/renov|assin|subscri|plano/.test(t)) return n === 1 ? "renovação" : "renovações";
  return n === 1 ? "compra" : "compras";
}

export function CommercialHistory({ contactId }: { contactId: string }) {
  const [data, setData] = useState<ContactCommercialProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(() => {
    if (!contactId) return;
    setLoading(true);
    getContactCommercialProfile(contactId)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [contactId]);

  useEffect(() => {
    load();
  }, [load]);

  // 🔄 Recarrega na hora quando uma venda é registrada pra ESTE contato
  // (Ganho na lateral da conversa dispara o evento) — sem F5.
  useEffect(() => {
    const onRefresh = (e: Event) => {
      const detail = (e as CustomEvent<{ contactId?: string }>).detail;
      if (detail?.contactId === contactId) load();
    };
    window.addEventListener("fluxia:commercial-refresh", onRefresh);
    return () =>
      window.removeEventListener("fluxia:commercial-refresh", onRefresh);
  }, [contactId, load]);

  // Sem histórico: não polui o painel (mensagem discreta).
  if (loading) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Carregando histórico…
      </div>
    );
  }
  if (!data || !data.hasData) {
    return (
      <div className="mt-4 rounded-lg border border-dashed border-border/60 px-3 py-2.5 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5 font-medium text-foreground/70">
          <ShoppingBag className="h-3.5 w-3.5" />
          Histórico de compras
        </div>
        <p className="mt-1 leading-snug">
          Nenhuma compra registrada. Importe em{" "}
          <strong>Configurações → Importar → Histórico de vendas</strong> — a IA
          passa a atender já conhecendo o cliente.
        </p>
      </div>
    );
  }

  const ds = daysSince(data.lastTransactionAt);
  const avg = data.averageRepurchaseDays
    ? Math.round(parseFloat(data.averageRepurchaseDays))
    : null;
  const overdue = ds != null && avg != null && avg > 0 ? ds - avg : null;
  const lastType = data.transactions[0]?.type;
  const nounMany = noun(lastType, data.transactionCount);

  return (
    <div className="mt-4 rounded-xl border border-border/60 bg-card/40">
      <div className="flex items-center justify-between px-3 pt-2.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <ShoppingBag className="h-3.5 w-3.5 text-primary" />
          Histórico de compras
        </div>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
          {data.transactionCount} {nounMany}
        </span>
      </div>

      {/* Métricas em grade */}
      <div className="grid grid-cols-2 gap-2 px-3 py-2.5 text-xs">
        <Metric
          label="Última compra"
          value={fmtDate(data.lastTransactionAt)}
          hint={ds != null ? `há ${ds} dia(s)` : undefined}
        />
        <Metric
          label="Frequência"
          value={avg != null ? `a cada ${avg} dia(s)` : "—"}
          hint={
            overdue != null && overdue > 3
              ? `atrasada ~${Math.round(overdue)}d`
              : undefined
          }
          hintTone={overdue != null && overdue > 3 ? "warn" : undefined}
        />
        <Metric label="Ticket médio" value={money(data.averageTicket)} />
        <Metric label="Total" value={money(data.totalRevenue)} />
        {data.preferredProduct && (
          <Metric label="Mais comprado" value={data.preferredProduct} span />
        )}
        {data.preferredPaymentMethod && (
          <Metric label="Pagamento" value={data.preferredPaymentMethod} />
        )}
        {data.nextExpectedAt && (
          <Metric
            label="Próxima prevista"
            value={fmtDate(data.nextExpectedAt)}
          />
        )}
      </div>

      {/* Lista das transações (expansível) */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1 border-t border-border/60 px-3 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        Ver {data.transactions.length} lançamento(s)
      </button>
      {expanded && (
        <div className="max-h-64 overflow-y-auto border-t border-border/60">
          {data.transactions.map((t, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs odd:bg-muted/20"
            >
              <div className="min-w-0">
                <div className="truncate text-foreground">
                  {t.product || "—"}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {fmtDate(t.occurredAt)}
                  {t.paymentMethod ? ` · ${t.paymentMethod}` : ""}
                </div>
              </div>
              <div className="shrink-0 font-medium tabular-nums text-foreground">
                {money(t.amount)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* O que a IA vê (transparência) */}
      {data.factsText && (
        <details className="border-t border-border/60 px-3 py-2">
          <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            O que a IA vê deste cliente
          </summary>
          <pre className="mt-1.5 whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] leading-snug text-muted-foreground">
            {data.factsText}
          </pre>
        </details>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  hintTone,
  span,
}: {
  label: string;
  value: string;
  hint?: string;
  hintTone?: "warn";
  span?: boolean;
}) {
  return (
    <div className={span ? "col-span-2" : undefined}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </div>
      <div className="truncate font-medium text-foreground">{value}</div>
      {hint && (
        <div
          className={
            hintTone === "warn"
              ? "text-[10px] font-medium text-amber-600 dark:text-amber-500"
              : "text-[10px] text-muted-foreground"
          }
        >
          {hint}
        </div>
      )}
    </div>
  );
}
