"use client";

import { useState, useEffect, useCallback } from "react";
import {
  listDealSuggestions,
  generateDealSuggestions,
  acceptDealSuggestion,
  dismissDealSuggestion,
  scheduleDealSuggestion,
  type DealSuggestion,
} from "@/app/(dashboard)/pipelines/actions";
import {
  Sparkles,
  Loader2,
  Check,
  X,
  CalendarClock,
  MessageSquareText,
} from "lucide-react";
import { toast } from "sonner";

function fmtDate(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}`;
}

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

/** ISO instant → "YYYY-MM-DDTHH:mm" no fuso LOCAL do navegador (input datetime-local). */
function isoToLocalInput(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`;
}

/**
 * IA para Negociações v2 — Fase 1/2: sugestões por evidência.
 * "Analisar com IA" lê a conversa e propõe campos (com evidência) e o próximo
 * passo: uma TAREFA interna ou uma MENSAGEM pronta para agendar. O humano
 * confirma tudo — nada é gravado nem enviado sozinho.
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

  // Editor inline da sugestão de MENSAGEM (revisar texto + horário).
  const [editId, setEditId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftWhen, setDraftWhen] = useState("");

  const load = useCallback(async () => {
    setItems(await listDealSuggestions(dealId).catch(() => []));
  }, [dealId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function analyze() {
    if (analyzing) return;
    setAnalyzing(true);
    setEditId(null);
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
    if (editId === id) setEditId(null);
    setItems((prev) => prev.filter((s) => s.id !== id));
  }

  function openEditor(s: DealSuggestion) {
    setEditId(s.id);
    setDraftText(s.value);
    setDraftWhen(
      isoToLocalInput(s.due_at ?? new Date(Date.now() + 3600_000).toISOString()),
    );
  }

  async function confirmSchedule(id: string) {
    const when = new Date(draftWhen);
    if (Number.isNaN(when.getTime())) {
      toast.error("Escolha uma data/hora válida.");
      return;
    }
    if (!draftText.trim()) {
      toast.error("Escreva a mensagem.");
      return;
    }
    setBusyId(id);
    const { error } = await scheduleDealSuggestion(id, {
      text: draftText,
      scheduledAt: when.toISOString(),
    });
    setBusyId(null);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(`Mensagem agendada para ${fmtDateTime(when.toISOString())}`);
    setEditId(null);
    setItems((prev) => prev.filter((s) => s.id !== id));
    onApplied?.();
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
          ela lê a conversa, propõe campos (com evidência) e o próximo passo
          (uma tarefa ou uma <strong>mensagem pronta para agendar</strong>).
          Você confirma o que quiser.
        </p>
      ) : (
        <div className="space-y-1.5">
          {items.map((s) => {
            // ---- Sugestão de MENSAGEM (agendar) ----
            if (s.kind === "message") {
              const editing = editId === s.id;
              const busy = busyId === s.id;
              return (
                <div
                  key={s.id}
                  className="rounded-md border border-sky-500/30 bg-sky-500/5 p-2"
                >
                  {editing ? (
                    <div className="space-y-2">
                      <p className="flex items-center gap-1 text-xs font-medium text-foreground">
                        <MessageSquareText className="h-3.5 w-3.5 text-sky-500" />
                        Revisar e agendar
                      </p>
                      <textarea
                        value={draftText}
                        onChange={(e) => setDraftText(e.target.value)}
                        rows={5}
                        className="w-full resize-y rounded-md border border-border bg-background p-2 text-xs text-foreground outline-none focus:border-sky-500"
                      />
                      <label className="block text-[11px] text-muted-foreground">
                        Disparar em
                        <input
                          type="datetime-local"
                          value={draftWhen}
                          onChange={(e) => setDraftWhen(e.target.value)}
                          className="mt-0.5 block w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-sky-500"
                        />
                      </label>
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setEditId(null)}
                          disabled={busy}
                          className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          onClick={() => void confirmSchedule(s.id)}
                          disabled={busy}
                          className="inline-flex items-center gap-1 rounded-md bg-sky-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
                        >
                          {busy ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <CalendarClock className="h-3 w-3" />
                          )}
                          Agendar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-2">
                        <p className="flex min-w-0 items-center gap-1 text-xs">
                          <MessageSquareText className="h-3.5 w-3.5 shrink-0 text-sky-500" />
                          <span className="font-medium text-foreground">
                            Mensagem de follow-up
                          </span>
                          {s.due_at && (
                            <span className="truncate text-muted-foreground">
                              · sugerido {fmtDateTime(s.due_at)}
                            </span>
                          )}
                        </p>
                        <button
                          type="button"
                          onClick={() => void dismiss(s.id)}
                          disabled={busy}
                          title="Descartar"
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11px] text-foreground/80">
                        {s.value}
                      </p>
                      {s.evidence && (
                        <p className="mt-0.5 text-[10px] italic text-muted-foreground">
                          motivo: {s.evidence}
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={() => openEditor(s)}
                        className="mt-1.5 inline-flex w-full items-center justify-center gap-1 rounded-md bg-sky-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-sky-500"
                      >
                        <CalendarClock className="h-3 w-3" /> Revisar e agendar
                      </button>
                    </>
                  )}
                </div>
              );
            }

            // ---- Campo ou Tarefa (aceitar aplica direto) ----
            return (
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
            );
          })}
        </div>
      )}
    </div>
  );
}
