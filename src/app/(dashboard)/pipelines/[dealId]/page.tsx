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
  Package,
  Paperclip,
  Trash2,
  Download,
  Upload,
  ClipboardList,
  FileText,
  Mail,
  Printer,
  Copy,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DealForm } from "@/components/pipelines/deal-form";
import { TaskForm } from "@/components/tarefas/task-form";
import { TransferDealButton } from "@/components/pipelines/transfer-deal-button";
import {
  getDeal,
  listStages,
  listDealEvents,
  moveDealToStage,
  setDealStatus,
  duplicateDeal,
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
import {
  listDealProducts,
  addDealProduct,
  removeDealProduct,
  listDealAttachments,
  addDealAttachment,
  removeDealAttachment,
  listDealQuestions,
  addDealQuestion,
  updateDealQuestionAnswer,
  removeDealQuestion,
  listDealEmails,
  addDealEmail,
  removeDealEmail,
  type DealProduct,
  type DealAttachment,
  type DealQuestion,
  type DealEmail,
} from "@/app/(dashboard)/pipelines/actions";
import type { Deal, PipelineStage, CustomField } from "@/types";
import {
  listCustomFields,
  listContactCustomValues,
  saveContactCustomValues,
} from "@/app/(dashboard)/contacts/actions";
import { CustomFieldInput } from "@/components/contacts/custom-field-input";

type DealTab =
  | "historico"
  | "tarefas"
  | "produtos"
  | "arquivos"
  | "questionarios"
  | "propostas"
  | "email";

const DEAL_TABS: { key: DealTab; label: string; icon: typeof Package }[] = [
  { key: "historico", label: "Histórico", icon: Clock },
  { key: "tarefas", label: "Tarefas", icon: CheckCircle2 },
  { key: "produtos", label: "Produtos", icon: Package },
  { key: "arquivos", label: "Arquivos", icon: Paperclip },
  { key: "questionarios", label: "Questionários", icon: ClipboardList },
  { key: "propostas", label: "Propostas", icon: FileText },
  { key: "email", label: "E-mail", icon: Mail },
];

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

const TEMPERATURE_LABEL: Record<string, string> = {
  frio: "🧊 Frio",
  morno: "🌤️ Morno",
  quente: "🔥 Quente",
};

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
      if (to === "lost") {
        const reason = d.reason ? String(d.reason).trim() : "";
        return {
          icon: <XCircle className="h-4 w-4 text-red-600" />,
          text: reason
            ? `marcou como perdido · motivo: ${reason}`
            : "marcou como perdido",
        };
      }
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
    case "transferred":
      return {
        icon: <ArrowRightLeft className="h-4 w-4 text-primary" />,
        text: d.to
          ? `transferiu o lead para ${String(d.to)}`
          : "transferiu o lead",
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
  const [products, setProducts] = useState<DealProduct[]>([]);
  const [attachments, setAttachments] = useState<DealAttachment[]>([]);
  const [questions, setQuestions] = useState<DealQuestion[]>([]);
  const [emails, setEmails] = useState<DealEmail[]>([]);
  const [tab, setTab] = useState<DealTab>("historico");
  const [prodName, setProdName] = useState("");
  const [prodQty, setProdQty] = useState("1");
  const [prodPrice, setProdPrice] = useState("");
  const [addingProduct, setAddingProduct] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [newQuestion, setNewQuestion] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [pickerContacts, setPickerContacts] = useState<PickerOption[]>([]);
  const [pickerDeals, setPickerDeals] = useState<PickerOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  // Campos personalizados (do contato) mostrados no negócio — paridade RD.
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [customDirty, setCustomDirty] = useState(false);
  const [savingCustom, setSavingCustom] = useState(false);

  const reload = useCallback(async () => {
    if (!dealId) return;
    const d = await getDeal(dealId).catch(() => null);
    if (!d) {
      setNotFound(true);
      setDeal(null);
      return;
    }
    setDeal(d);
    const [st, ev, tk, pr, at, qs, em] = await Promise.all([
      listStages(d.pipeline_id).catch(() => [] as PipelineStage[]),
      listDealEvents(dealId).catch(() => [] as DealEvent[]),
      listTasksByDeal(dealId).catch(() => [] as TaskLite[]),
      listDealProducts(dealId).catch(() => [] as DealProduct[]),
      listDealAttachments(dealId).catch(() => [] as DealAttachment[]),
      listDealQuestions(dealId).catch(() => [] as DealQuestion[]),
      listDealEmails(dealId).catch(() => [] as DealEmail[]),
    ]);
    setStages(st);
    setEvents(ev);
    setTasks(tk);
    setProducts(pr);
    setAttachments(at);
    setQuestions(qs);
    setEmails(em);

    // Campos personalizados (definição da conta + valores do contato do deal).
    const [cf, cv] = await Promise.all([
      listCustomFields().catch(() => [] as CustomField[]),
      d.contact_id
        ? listContactCustomValues(d.contact_id).catch(() => [])
        : Promise.resolve([]),
    ]);
    setCustomFields(cf);
    const map: Record<string, string> = {};
    for (const row of cv) map[row.custom_field_id] = row.value ?? "";
    setCustomValues(map);
    setCustomDirty(false);
  }, [dealId]);

  const handleSaveCustom = useCallback(async () => {
    if (!deal?.contact_id) return;
    setSavingCustom(true);
    const { error } = await saveContactCustomValues(
      deal.contact_id,
      customValues,
    );
    setSavingCustom(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Campos salvos");
    setCustomDirty(false);
  }, [deal?.contact_id, customValues]);

  const submitQuestion = useCallback(async () => {
    if (!deal) return;
    const q = newQuestion.trim();
    if (!q) return;
    const { error } = await addDealQuestion(deal.id, { question: q });
    if (error) toast.error(error);
    else {
      setNewQuestion("");
      setQuestions(await listDealQuestions(deal.id).catch(() => questions));
    }
  }, [deal, newQuestion, questions]);

  const saveAnswer = useCallback(
    async (id: string, answer: string) => {
      const { error } = await updateDealQuestionAnswer(id, answer);
      if (error) toast.error(error);
    },
    [],
  );

  const deleteQuestion = useCallback(async (id: string) => {
    const { error } = await removeDealQuestion(id);
    if (error) toast.error(error);
    else setQuestions((prev) => prev.filter((q) => q.id !== id));
  }, []);

  const submitEmail = useCallback(async () => {
    if (!deal) return;
    const subject = emailSubject.trim();
    if (!subject) return;
    const { error } = await addDealEmail(deal.id, { subject, body: emailBody });
    if (error) toast.error(error);
    else {
      setEmailSubject("");
      setEmailBody("");
      setEmails(await listDealEmails(deal.id).catch(() => emails));
    }
  }, [deal, emailSubject, emailBody, emails]);

  const deleteEmail = useCallback(async (id: string) => {
    const { error } = await removeDealEmail(id);
    if (error) toast.error(error);
    else setEmails((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const submitProduct = useCallback(async () => {
    if (!deal || addingProduct) return;
    const name = prodName.trim();
    if (!name) return;
    setAddingProduct(true);
    const { error } = await addDealProduct(deal.id, {
      name,
      quantity: parseFloat(prodQty) || 1,
      unit_price: parseFloat(prodPrice) || 0,
    });
    if (error) toast.error(error);
    else {
      setProdName("");
      setProdQty("1");
      setProdPrice("");
      // reload() refetches the deal too, so the synced VALOR updates.
      await reload();
    }
    setAddingProduct(false);
  }, [deal, addingProduct, prodName, prodQty, prodPrice, reload]);

  const deleteProduct = useCallback(
    async (id: string) => {
      if (!deal) return;
      const { error } = await removeDealProduct(id);
      if (error) toast.error(error);
      else await reload();
    },
    [deal, reload],
  );

  const uploadFile = useCallback(
    async (file: File) => {
      if (!deal || uploading) return;
      setUploading(true);
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("bucket", "media");
        const res = await fetch("/api/media/upload", {
          method: "POST",
          body: fd,
        });
        const data = (await res.json().catch(() => ({}))) as {
          publicUrl?: string;
          error?: string;
        };
        if (!res.ok || !data.publicUrl) {
          toast.error(data.error || "Falha no upload do arquivo");
          return;
        }
        const { error } = await addDealAttachment(deal.id, {
          name: file.name,
          url: data.publicUrl,
          mime: file.type,
          size: file.size,
        });
        if (error) toast.error(error);
        else setAttachments(await listDealAttachments(deal.id).catch(() => attachments));
      } finally {
        setUploading(false);
      }
    },
    [deal, uploading, attachments],
  );

  const deleteAttachment = useCallback(
    async (id: string) => {
      const { error } = await removeDealAttachment(id);
      if (error) toast.error(error);
      else setAttachments((prev) => prev.filter((a) => a.id !== id));
    },
    [],
  );

  const productsTotal = useMemo(
    () => products.reduce((sum, p) => sum + p.quantity * p.unit_price, 0),
    [products],
  );

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

  // Motivo de perda (estilo RD): "Marcar perda" abre o campo do porquê.
  const [lostOpen, setLostOpen] = useState(false);
  const [lostReason, setLostReason] = useState("");

  const markStatus = useCallback(
    async (status: "open" | "won" | "lost", reason?: string) => {
      if (!deal || busy) return;
      setBusy(true);
      const { error } = await setDealStatus(deal.id, status, reason);
      if (error) toast.error(error);
      else {
        toast.success(
          status === "won"
            ? "Marcado como venda 🏆"
            : status === "lost"
              ? "Marcado como perdido"
              : "Negócio reaberto",
        );
        setLostOpen(false);
      }
      await reload();
      setBusy(false);
    },
    [deal, busy, reload],
  );

  const handleDuplicate = useCallback(async () => {
    if (!deal || busy) return;
    setBusy(true);
    const { error, id } = await duplicateDeal(deal.id);
    setBusy(false);
    if (error || !id) {
      toast.error(error || "Falha ao duplicar");
      return;
    }
    toast.success("Negócio duplicado");
    window.location.href = `/pipelines/${id}`;
  }, [deal, busy]);

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
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (notFound || !deal) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
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
    <div className="flex flex-col">
      {/* Header — sticky no topo enquanto rola o conteúdo. */}
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
        <button
          type="button"
          onClick={() => (window.location.href = "/pipelines")}
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Voltar"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1 basis-full sm:basis-0">
          <h1 className="line-clamp-2 text-base font-semibold leading-snug text-foreground sm:text-lg">
            {deal.title}
          </h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate">{deal.pipeline_name ?? "Funil"}</span>
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
              onClick={() => setLostOpen((v) => !v)}
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
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void handleDuplicate()}
            title="Duplicar negócio"
          >
            <Copy className="mr-1.5 h-4 w-4" /> Duplicar
          </Button>
        </div>
      </header>

      {/* Motivo da perda (estilo RD) — aparece ao clicar "Marcar perda". */}
      {lostOpen && status !== "lost" && (
        <div className="space-y-2 border-b border-red-500/30 bg-red-500/5 px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground">
            Por que este negócio foi perdido?
          </p>
          <div className="flex flex-wrap gap-1.5">
            {[
              "Não responde",
              "Achou caro",
              "Comprou concorrente",
              "Sem orçamento agora",
              "Preferiu esperar",
            ].map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setLostReason(r)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                  lostReason === r
                    ? "border-red-500 bg-red-500/20 text-red-500"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              placeholder="Ou escreva o motivo…"
              className="h-8 flex-1 border-border bg-background text-sm"
            />
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void markStatus("lost", lostReason)}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              Confirmar perda
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLostOpen(false)}
            >
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {/* Barra de etapas (stepper) — "setas" (RD) ou "pílulas" conforme o funil. */}
      {deal.pipeline_stepper_style === "chevrons" ? (
        <div className="flex overflow-x-auto border-b border-border bg-background px-2 py-2">
          {stages.map((s, i) => {
            const active = s.id === deal.stage_id;
            const reached = currentStageIndex >= 0 && i <= currentStageIndex;
            return (
              <button
                key={s.id}
                type="button"
                disabled={busy}
                onClick={() => void changeStage(s.id)}
                title={`Mover para "${s.name}"`}
                className={cn(
                  "relative flex h-8 shrink-0 items-center whitespace-nowrap pl-5 pr-4 text-xs transition-opacity hover:opacity-90",
                  reached ? "font-medium text-white" : "bg-muted text-muted-foreground",
                  active && "font-semibold",
                )}
                style={{
                  backgroundColor: reached ? s.color || "#6d28d9" : undefined,
                  marginLeft: i === 0 ? 0 : -10,
                  clipPath:
                    i === 0
                      ? "polygon(0 0, calc(100% - 11px) 0, 100% 50%, calc(100% - 11px) 100%, 0 100%)"
                      : "polygon(0 0, calc(100% - 11px) 0, 100% 50%, calc(100% - 11px) 100%, 0 100%, 11px 50%)",
                }}
              >
                {s.name}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-border bg-background px-4 py-2">
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
      )}

      {/* Corpo: campos | histórico */}
      <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-start">
        {/* Painel de campos — cola no topo no desktop enquanto rola as abas. */}
        <aside className="w-full shrink-0 space-y-4 rounded-xl border border-border bg-card p-4 lg:sticky lg:top-20 lg:w-72">
          <h2 className="text-sm font-semibold text-foreground">Negócio</h2>
          <div className="space-y-3">
            <Field label="Nome" value={deal.title} />
            <Field label="Valor" value={fmtCurrency(deal.value, deal.currency)} />
            <Field label="Contato" value={deal.contact?.name || deal.contact?.phone} />
            <div>
              <Field label="Responsável" value={deal.assignee?.full_name} />
              <div className="mt-1.5">
                <TransferDealButton
                  dealId={deal.id}
                  currentAssigneeId={deal.assigned_to ?? null}
                  onTransferred={() => {
                    window.location.href = "/pipelines";
                  }}
                />
              </div>
            </div>
            <Field
              label="Temperatura"
              value={
                deal.temperature
                  ? (TEMPERATURE_LABEL[deal.temperature] ?? deal.temperature)
                  : null
              }
            />
            <Field label="Fonte" value={deal.source} />
            <Field label="Origem" value={deal.origin} />
            <Field label="Previsão de fechamento" value={fmtDate(deal.expected_close_date)} />
            <Field label="Criado em" value={fmtDateTime(deal.created_at)} />
            <Field label="Status" value={statusMeta.label} />
            {deal.notes?.trim() && <Field label="Observações" value={deal.notes} />}
          </div>

          {/* Campos personalizados (do contato) — editáveis, estilo RD. */}
          {deal.contact_id && customFields.length > 0 && (
            <div className="mt-4 space-y-2 border-t border-border pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Campos personalizados
              </p>
              {customFields.map((field) => (
                <div key={field.id} className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground">
                    {field.field_name}
                  </label>
                  <CustomFieldInput
                    field={field}
                    value={customValues[field.id] ?? ""}
                    onChange={(val) => {
                      setCustomValues((prev) => ({ ...prev, [field.id]: val }));
                      setCustomDirty(true);
                    }}
                  />
                </div>
              ))}
              {customDirty && (
                <Button
                  size="sm"
                  onClick={() => void handleSaveCustom()}
                  disabled={savingCustom}
                  className="mt-1 w-full bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {savingCustom ? "Salvando…" : "Salvar campos"}
                </Button>
              )}
            </div>
          )}
        </aside>

        {/* Histórico */}
        <section className="flex min-w-0 flex-1 flex-col gap-4">
          {/* Abas estilo RD */}
          <div className="-mx-1 flex flex-wrap gap-1 border-b border-border px-1 pb-2">
            {DEAL_TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t.label}
                </button>
              );
            })}
          </div>

          {tab === "historico" && (
            <>
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

            </>
          )}

          {tab === "tarefas" && (
          /* Tarefas do lead */
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

          )}

          {tab === "produtos" && (
          /* Produtos */
          <div className="rounded-xl border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Package className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Produtos</h2>
            </div>
            {products.length > 0 && (
              <ul className="divide-y divide-border">
                {products.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{p.name}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {p.quantity} × {fmtCurrency(p.unit_price, deal.currency)}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-medium text-foreground">
                      {fmtCurrency(p.quantity * p.unit_price, deal.currency)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void deleteProduct(p.id)}
                      className="shrink-0 text-muted-foreground transition-colors hover:text-red-500"
                      aria-label="Remover produto"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {/* Adicionar item */}
            <div className="flex flex-wrap items-end gap-2 border-t border-border px-4 py-3">
              <input
                value={prodName}
                onChange={(e) => setProdName(e.target.value)}
                placeholder="Produto/serviço"
                className="min-w-40 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary/50"
              />
              <input
                value={prodQty}
                onChange={(e) => setProdQty(e.target.value)}
                type="number"
                min="0"
                step="1"
                placeholder="Qtd"
                className="w-16 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary/50"
              />
              <input
                value={prodPrice}
                onChange={(e) => setProdPrice(e.target.value)}
                type="number"
                min="0"
                step="0.01"
                placeholder="Preço un."
                className="w-24 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary/50"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitProduct();
                }}
              />
              <Button
                size="sm"
                disabled={!prodName.trim() || addingProduct}
                onClick={() => void submitProduct()}
              >
                <Plus className="mr-1 h-4 w-4" /> Adicionar
              </Button>
            </div>
            {products.length > 0 && (
              <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Total dos produtos
                </span>
                <span className="text-sm font-bold text-primary">
                  {fmtCurrency(productsTotal, deal.currency)}
                </span>
              </div>
            )}
          </div>

          )}

          {tab === "arquivos" && (
          /* Arquivos / anexos */
          <div className="rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <Paperclip className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">Arquivos</h2>
              </div>
              <label
                className={cn(
                  "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted",
                  uploading && "pointer-events-none opacity-60",
                )}
              >
                <Upload className="h-3.5 w-3.5" />
                {uploading ? "Enviando…" : "Anexar"}
                <input
                  type="file"
                  className="hidden"
                  disabled={uploading}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadFile(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            {attachments.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                Nenhum arquivo anexado.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {attachments.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                    <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      download={a.name}
                      className="min-w-0 flex-1 truncate text-sm text-foreground hover:underline"
                      title={a.name}
                    >
                      {a.name}
                    </a>
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      download={a.name}
                      className="shrink-0 text-muted-foreground transition-colors hover:text-primary"
                      aria-label="Baixar"
                    >
                      <Download className="h-4 w-4" />
                    </a>
                    <button
                      type="button"
                      onClick={() => void deleteAttachment(a.id)}
                      className="shrink-0 text-muted-foreground transition-colors hover:text-red-500"
                      aria-label="Remover arquivo"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          )}

          {tab === "historico" && (
          /* Timeline */
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
          )}

          {tab === "questionarios" && (
            <div className="rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <ClipboardList className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">
                  Questionários
                </h2>
              </div>
              {questions.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                  Nenhuma pergunta de qualificação ainda.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {questions.map((q) => (
                    <li key={q.id} className="px-4 py-3">
                      <div className="flex items-start gap-2">
                        <p className="min-w-0 flex-1 text-sm font-medium text-foreground">
                          {q.question}
                        </p>
                        <button
                          type="button"
                          onClick={() => void deleteQuestion(q.id)}
                          className="shrink-0 text-muted-foreground transition-colors hover:text-red-500"
                          aria-label="Remover pergunta"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                      <textarea
                        defaultValue={q.answer ?? ""}
                        onBlur={(e) => void saveAnswer(q.id, e.target.value)}
                        placeholder="Resposta…"
                        rows={1}
                        className="mt-1.5 w-full resize-none rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary/50"
                      />
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-end gap-2 border-t border-border px-4 py-3">
                <input
                  value={newQuestion}
                  onChange={(e) => setNewQuestion(e.target.value)}
                  placeholder="Nova pergunta (ex.: Qual o orçamento?)"
                  className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary/50"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitQuestion();
                  }}
                />
                <Button
                  size="sm"
                  disabled={!newQuestion.trim()}
                  onClick={() => void submitQuestion()}
                >
                  <Plus className="mr-1 h-4 w-4" /> Adicionar
                </Button>
              </div>
            </div>
          )}

          {tab === "propostas" && (
            <div className="rounded-xl border border-border bg-card">
              <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-semibold text-foreground">Proposta</h2>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => window.print()}
                  disabled={products.length === 0}
                >
                  <Printer className="mr-1.5 h-4 w-4" /> Imprimir / PDF
                </Button>
              </div>
              {products.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                  Adicione itens na aba &quot;Produtos&quot; para gerar a proposta.
                </p>
              ) : (
                <div className="p-4">
                  <p className="text-base font-semibold text-foreground">
                    Proposta — {deal.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Cliente: {deal.contact?.name || deal.contact?.phone || "—"}
                  </p>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="py-1.5 pr-2 font-medium">Produto</th>
                          <th className="py-1.5 px-2 text-right font-medium">Qtd</th>
                          <th className="py-1.5 px-2 text-right font-medium">
                            Preço un.
                          </th>
                          <th className="py-1.5 pl-2 text-right font-medium">
                            Subtotal
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {products.map((p) => (
                          <tr key={p.id} className="border-b border-border/60">
                            <td className="py-1.5 pr-2 text-foreground">{p.name}</td>
                            <td className="py-1.5 px-2 text-right text-muted-foreground">
                              {p.quantity}
                            </td>
                            <td className="py-1.5 px-2 text-right text-muted-foreground">
                              {fmtCurrency(p.unit_price, deal.currency)}
                            </td>
                            <td className="py-1.5 pl-2 text-right text-foreground">
                              {fmtCurrency(p.quantity * p.unit_price, deal.currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-3 flex items-center justify-between border-t border-border pt-2">
                    <span className="text-sm font-medium text-foreground">Total</span>
                    <span className="text-base font-bold text-primary">
                      {fmtCurrency(productsTotal, deal.currency)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "email" && (
            <div className="rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <Mail className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">E-mails</h2>
              </div>
              <div className="space-y-2 border-b border-border px-4 py-3">
                <input
                  value={emailSubject}
                  onChange={(e) => setEmailSubject(e.target.value)}
                  placeholder="Assunto do e-mail"
                  className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary/50"
                />
                <textarea
                  value={emailBody}
                  onChange={(e) => setEmailBody(e.target.value)}
                  placeholder="Cole ou anote o conteúdo do e-mail trocado com o lead…"
                  rows={3}
                  className="w-full resize-none rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary/50"
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={!emailSubject.trim()}
                    onClick={() => void submitEmail()}
                  >
                    <Plus className="mr-1 h-4 w-4" /> Registrar e-mail
                  </Button>
                </div>
              </div>
              {emails.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                  Nenhum e-mail registrado. Registre aqui os e-mails trocados com
                  o lead.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {emails.map((em) => (
                    <li key={em.id} className="flex items-start gap-2 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {em.subject}
                        </p>
                        {em.body && (
                          <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                            {em.body}
                          </p>
                        )}
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {em.actor_name ? `${em.actor_name} · ` : ""}
                          {fmtDateTime(em.created_at)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void deleteEmail(em.id)}
                        className="shrink-0 text-muted-foreground transition-colors hover:text-red-500"
                        aria-label="Remover e-mail"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
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
