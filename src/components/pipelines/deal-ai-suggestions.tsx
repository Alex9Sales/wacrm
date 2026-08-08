"use client";

import { useState, useEffect, useCallback } from "react";
import {
  listDealSuggestions,
  generateDealSuggestions,
  acceptDealSuggestion,
  dismissDealSuggestion,
  type DealSuggestion,
} from "@/app/(dashboard)/pipelines/actions";
import { Sparkles, Loader2, Check, X, CalendarClock } from "lucide-react";
import { toast } from "sonner";

function fmtDate(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}`;
}

/**
 * IA para Negociações v2 — Fase 1: sugestões por evidência.
 * "Analisar com IA" lê a conversa e propõe campos (com evidência); o humano
 * aceita (aplica) ou descarta. Nada é gravado sozinho.
 */
export function DealAISuggestions({
  dealId,
  onApplied,
}: {
  dealId: string;
  onApplied?: () => void;
}) {
  const [items, setItems] = useState<DealSuggestion[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setItems(await listDealSuggestions(dealId).catch(() => []));
  }, [dealId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function analyze() {
    if (analyzing) return;
    setAnalyzing(true);
    const res = await generateDealSuggestions(dealId);
    setAnalyzing(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    await load();
    if (res.count === 0) {
      toast("Nenhuma sugestão com evidência na conversa.");
    } else {
      toast.success(
        `${res.count} sugest${res.count === 1 ? "ão" : "ões"} da IA`,
      );
    }
  }

  async function accept(id: string) {
    setBusyId(id);
    const { error } = await acceptDealSuggestion(id);
    setBusyId(null);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Aplicado");
    setItems((prev) => prev.filter((s) => s.id !== id));
    onApplied?.();
  }

  async function dismiss(id: string) {
    setBusyId(id);
    await dismissDealSuggestion(id).catch(() => {});
    setBusyId(null);
    setItems((prev) => prev.filter((s) => s.id !== id));
  }

  return (
    <div className="space-y-2 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-600 dark:text-amber-400">
          <Sparkles className="h-4 w-4" /> Sugestões da IA
        </p>
        <button
          type="button"
          onClick={() => void analyze()}
          disabled={analyzing}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          {analyzing ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" /> Analisando…
            </>
          ) : (
            "Analisar com IA"
          )}
        </button>
      </div>

      {items.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          Sem sugestões pendentes. Clique em <strong>Analisar com IA</strong> —
          ela lê a conversa e propõe campos, sempre <strong>com a evidência</strong>.
          Você confirma o que quiser.
        </p>
      ) : (
        <div className="space-y-1.5">
          {items.map((s) => (
            <div
              key={s.id}
              className="rounded-md border border-border bg-background p-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  {s.kind === "task" ? (
                    <>
                      <p className="flex items-center gap-1 text-xs">
                        <CalendarClock className="h-3 w-3 shrink-0 text-amber-500" />
                        <span className="font-medium text-foreground">
                          {s.value}
                        </span>
                        {s.due_at && (
                          <span className="text-muted-foreground">
                            · vence {fmtDate(s.due_at)}
                          </span>
                        )}
                      </p>
                      {s.evidence && (
                        <p className="mt-0.5 text-[10px] italic text-muted-foreground">
                          motivo: {s.evidence}
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="text-xs">
                        <span className="text-muted-foreground">
                          {s.label}:{" "}
                        </span>
                        <span className="font-medium text-foreground">
                          {s.value}
                        </span>
                      </p>
                      {s.evidence && (
                        <p className="mt-0.5 text-[10px] italic text-muted-foreground">
                          “{s.evidence}”
                        </p>
                      )}
                    </>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => void accept(s.id)}
                    disabled={busyId === s.id}
                    title="Aceitar e aplicar"
                    className="flex h-6 w-6 items-center justify-center rounded bg-primary text-primary-foreground transition-opacity hover:bg-primary/90 disabled:opacity-50"
                  >
                    {busyId === s.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => void dismiss(s.id)}
                    disabled={busyId === s.id}
                    title="Descartar"
                    className="flex h-6 w-6 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
