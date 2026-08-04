"use client";

// ============================================================
// Deal detail page (estilo RD Station): barra de etapas clicável, painel de
// campos do negócio, Marcar venda / Marcar perda, e o Histórico (timeline de
// eventos + anotações). Aberto ao clicar num card do funil.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Loader2,
  Pencil,
  Trophy,
  XCircle,
  RotateCcw,
  StickyNote,
  ArrowRightLeft,
  Sparkles,
  Clock,
  Plus,
  CheckCircle2,
  Circle,
  CalendarClock,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DealForm } from "@/components/pipelines/deal-form";
import { TaskForm } from "@/components/tarefas/task-form";
import {
  getDeal,
  listStages,
  listDealEvents,
  moveDealToStage,
  setDealStatus,
  addDealNote,
  type DealEvent,
} from "@/app/(dashboard)/pipelines/actions";
import {
  listTasksByDeal,
  toggleTaskDone,
  listContactsForPicker,
  listDealsForPicker,
  type TaskLite,
  type PickerOption,
} from "@/app/(dashboard)/tarefas/actions";
import type { Deal, PipelineStage } from "@/types";

function fmtDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR");
}

function fmtCurrency(value: number, currency?: string): string {
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: currency || "BRL",
    }).format(value);
  } catch {
    return `${currency || "BRL"} ${value.toFixed(2)}`;
  }
}

const STATUS_META: Record<string, { label: string; className: string }> = {
  open: { label: "Aberto", className: "bg-muted text-muted-foreground" },
  won: { label: "Venda ganha", className: "bg-emerald-500/15 text-emerald-600" },
  lost: { label: "Perdido", className: "bg-red-500/15 text-red-600" },
};

/** Human sentence + icon for a timeline event. */
function describeEvent(e: DealEvent): { icon: React.ReactNode; text: string } {
  const d = e.data ?? {};
  switch (e.type) {
    case "created":
      return {
        icon: <Sparkles className="h-4 w-4 text-primary" />,
        text: d.stage
          ? `criou o negócio na etapa "${String(d.stage)}"`
          : "criou o negócio",
      };
    case "stage_changed":
      return {
        icon: <ArrowRightLeft className="h-4 w-4 text-primary" />,
        text: `moveu de "${String(d.from ?? "—")}" para "${String(d.to ?? "—")}"`,
      };
    case "status_changed": {
      const to = String(d.to ?? "");
      if (to === "won")
        return {
          icon: <Trophy className="h-4 w-4 text-emerald-600" />,
          text: "marcou como venda ganha 🏆",
        };
      if (to === "lost")
        return {
          icon: <XCircle className="h-4 w-4 text-red-600" />,
          text: "marcou como perdido",
        };
      return {
        icon: <RotateCcw className="h-4 w-4 text-muted-foreground" />,
        text: "reabriu o negócio",
      };
    }
    case "note":
      return {
        icon: <StickyNote className="h-4 w-4 text-amber-500" />,
        text: String(d.text ?? ""),
      };
    default:
      return { icon: <Clock className="h-4 w-4 text-muted-foreground" />, text: e.type };
  }
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 break-words text-sm text-foreground">
        {value?.trim() ? value : "—"}
      </p>
    </div>
  );
}

export default function DealDetailPage() {
  const params = useParams<{ dealId: string }>();
  const dealId = params?.dealId;

  const [deal, setDeal] = useState<Deal | null>(null);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [events, setEvents] = useState<DealEvent[]>([]);
  const [tasks, setTasks] = useState<TaskLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [pickerContacts, setPickerContacts] = useState<PickerOption[]>([]);
  const [pickerDeals, setPickerDeals] = useState<PickerOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  const reload = useCallback(async () => {
    if (!dealId) return;
    const d = await getDeal(dealId).catch(() => null);
    if (!d) {
      setNotFound(true);
      setDeal(null);
      return;
    }
    setDeal(d);
    const [st, ev, tk] = await Promise.all([
      listStages(d.pipeline_id).catch(() => [] as PipelineStage[]),
      listDealEvents(dealId).catch(() => [] as DealEvent[]),
      listTasksByDeal(dealId).catch(() => [] as TaskLite[]),
    ]);
    setStages(st);
    setEvents(ev);
    setTasks(tk);
  }, [dealId]);

  // Picker options for the TaskForm (loaded once).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [c, d] = await Promise.all([
        listContactsForPicker().catch(() => [] as PickerOption[]),
        listDealsForPicker().catch(() => [] as PickerOption[]),
      ]);
      if (cancelled) return;
      setPickerContacts(c);
      setPickerDeals(d);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleTask = useCallback(async (taskId: string) => {
    const res = await toggleTaskDone(taskId);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status: res.status } : t)),
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await reload();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const changeStage = useCallback(
    async (stageId: string) => {
      if (!deal || busy || stageId === deal.stage_id) return;
      setBusy(true);
      const { error } = await moveDealToStage(deal.id, stageId);
      if (error) toast.error(error);
      await reload();
      setBusy(false);
    },
    [deal, busy, reload],
  );

  const markStatus = useCallback(
    async (status: "open" | "won" | "lost") => {
      if (!deal || busy) return;
      setBusy(true);
      const { error } = await setDealStatus(deal.id, status);
      if (error) toast.error(error);
      else
        toast.success(
          status === "won"
            ? "Marcado como venda 🏆"
            : status === "lost"
              ? "Marcado como perdido"
              : "Negócio reaberto",
        );
      await reload();
      setBusy(false);
    },
    [deal, busy, reload],
  );

  const submitNote = useCallback(async () => {
    if (!deal || savingNote) return;
    const text = note.trim();
    if (!text) return;
    setSavingNote(true);
    const { error } = await addDealNote(deal.id, text);
    if (error) toast.error(error);
    else {
      setNote("");
      await reload();
    }
    setSavingNote(false);
  }, [deal, note, savingNote, reload]);

  const status = deal?.status ?? "open";
  const statusMeta = STATUS_META[status] ?? STATUS_META.open;
  const currentStageIndex = useMemo(
    () => stages.findIndex((s) => s.id === deal?.stage_id),
    [stages, deal?.stage_id],
  );

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (notFound || !deal) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-muted-foreground">
          Negócio não encontrado ou você não tem acesso a ele.
        </p>
        <Button variant="outline" onClick={() => (window.location.href = "/pipelines")}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Voltar ao funil
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <button
          type="button"
          onClick={() => (window.location.href = "/pipelines")}
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Voltar"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold text-foreground">
            {deal.title}
          </h1>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span>{deal.pipeline_name ?? "Funil"}</span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-medium",
                statusMeta.className,
              )}
            >
              {statusMeta.label}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {status !== "won" && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void markStatus("won")}
              className="bg-emerald-600 text-white hover:bg-emerald-700"
            >
              <Trophy className="mr-1.5 h-4 w-4" /> Marcar venda
            </Button>
          )}
          {status !== "lost" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void markStatus("lost")}
              className="border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
            >
              <XCircle className="mr-1.5 h-4 w-4" /> Marcar perda
            </Button>
          )}
          {(status === "won" || status === "lost") && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void markStatus("open")}
            >
              <RotateCcw className="mr-1.5 h-4 w-4" /> Reabrir
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
            <Pencil className="mr-1.5 h-4 w-4" /> Editar
          </Button>
        </div>
      </header>

      {/* Barra de etapas (stepper) */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-4 py-2">
        {stages.map((s, i) => {
          const active = s.id === deal.stage_id;
          const done = currentStageIndex >= 0 && i < currentStageIndex;
          return (
            <button
              key={s.id}
              type="button"
              disabled={busy}
              onClick={() => void changeStage(s.id)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                active
                  ? "border-transparent text-white"
                  : done
                    ? "border-transparent bg-primary/10 text-primary hover:bg-primary/20"
                    : "border-border text-muted-foreground hover:bg-muted",
              )}
              style={active ? { backgroundColor: s.color || "#6d28d9" } : undefined}
              title={`Mover para "${s.name}"`}
            >
              <span
                className="size-1.5 rounded-full"
                style={{ backgroundColor: active ? "#ffffff" : s.color || "#6d28d9" }}
              />
              {s.name}
            </button>
          );
        })}
      </div>

      {/* Corpo: campos | histórico */}
      <div className="flex flex-1 flex-col gap-4 overflow-auto p-4 lg:flex-row">
        {/* Painel de campos */}
        <aside className="w-full shrink-0 space-y-4 rounded-xl border border-border bg-card p-4 lg:w-72">
          <h2 className="text-sm font-semibold text-foreground">Negócio</h2>
          <div className="space-y-3">
            <Field label="Nome" value={deal.title} />
            <Field label="Valor" value={fmtCurrency(deal.value, deal.currency)} />
            <Field label="Contato" value={deal.contact?.name || deal.contact?.phone} />
            <Field label="Responsável" value={deal.assignee?.full_name} />
            <Field label="Previsão de fechamento" value={fmtDate(deal.expected_close_date)} />
            <Field label="Criado em" value={fmtDateTime(deal.created_at)} />
            <Field label="Status" value={statusMeta.label} />
            {deal.notes?.trim() && <Field label="Observações" value={deal.notes} />}
          </div>
        </aside>

        {/* Histórico */}
        <section className="flex min-w-0 flex-1 flex-col gap-4">
          {/* Nova anotação */}
          <div className="rounded-xl border border-border bg-card p-3">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Escreva uma anotação sobre este negócio…"
              rows={2}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submitNote();
                }
              }}
            />
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                disabled={!note.trim() || savingNote}
                onClick={() => void submitNote()}
              >
                {savingNote ? "Salvando…" : "Adicionar anotação"}
              </Button>
            </div>
          </div>

          {/* Tarefas do lead */}
          <div className="rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-foreground">Tarefas</h2>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setTaskFormOpen(true)}
              >
                <Plus className="mr-1.5 h-4 w-4" /> Criar tarefa
              </Button>
            </div>
            {tasks.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                Nenhuma tarefa neste negócio ainda.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {tasks.map((t) => {
                  const done = t.status === "done";
                  return (
                    <li key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                      <button
                        type="button"
                        onClick={() => void toggleTask(t.id)}
                        className="shrink-0 text-muted-foreground transition-colors hover:text-primary"
                        aria-label={done ? "Reabrir tarefa" : "Concluir tarefa"}
                      >
                        {done ? (
                          <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                        ) : (
                          <Circle className="h-5 w-5" />
                        )}
                      </button>
                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            "truncate text-sm text-foreground",
                            done && "text-muted-foreground line-through",
                          )}
                        >
                          {t.title}
                        </p>
                        {t.due_at && (
                          <p
                            className={cn(
                              "mt-0.5 flex items-center gap-1 text-[11px]",
                              t.overdue
                                ? "text-red-500"
                                : "text-muted-foreground",
                            )}
                          >
                            <CalendarClock className="h-3 w-3" />
                            {fmtDateTime(t.due_at)}
                            {t.overdue && " · atrasada"}
                          </p>
                        )}
                      </div>
                      {t.type && (
                        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {t.type}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Timeline */}
          <div className="rounded-xl border border-border bg-card">
            <h2 className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
              Histórico
            </h2>
            {events.length === 0 ? (
              <p className="px-4 py-10 text-center text-xs text-muted-foreground">
                Nenhum evento ainda. Mudanças de etapa, venda/perda e anotações
                aparecem aqui.
              </p>
            ) : (
              <ol className="divide-y divide-border">
                {events.map((e) => {
                  const { icon, text } = describeEvent(e);
                  return (
                    <li key={e.id} className="flex gap-3 px-4 py-3">
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted">
                        {icon}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-foreground">
                          {e.actor_name && e.type !== "note" && (
                            <span className="font-medium">{e.actor_name} </span>
                          )}
                          {e.type === "note" ? (
                            <span className="whitespace-pre-wrap break-words">{text}</span>
                          ) : (
                            <span className="text-muted-foreground">{text}</span>
                          )}
                        </p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {e.type === "note" && e.actor_name ? `${e.actor_name} · ` : ""}
                          {fmtDateTime(e.created_at)}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </section>
      </div>

      {/* Editar negócio (reaproveita o formulário existente) */}
      {editOpen && (
        <DealForm
          open={editOpen}
          onOpenChange={setEditOpen}
          deal={deal}
          pipelineId={deal.pipeline_id}
          stages={stages}
          onSaved={() => {
            setEditOpen(false);
            void reload();
          }}
        />
      )}

      {/* Criar tarefa já vinculada a este lead (reaproveita o TaskForm). */}
      {taskFormOpen && (
        <TaskForm
          open={taskFormOpen}
          onOpenChange={setTaskFormOpen}
          contacts={pickerContacts}
          deals={pickerDeals}
          prefillContactId={deal.contact_id ?? undefined}
          prefillDealId={deal.id}
          onSaved={() => {
            setTaskFormOpen(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}
