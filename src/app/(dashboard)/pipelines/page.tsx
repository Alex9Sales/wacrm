"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  createPipelineWithStages,
  listDeals,
  listPipelines,
  listStages,
  moveDealToStage,
  getDealsWithProducts,
  getDealAiHints,
  type DealAiHint,
} from "./actions";
import type { Pipeline, PipelineStage, Deal } from "@/types";
import {
  getDealTaskCounts,
  type DealTaskCount,
  type PickerOption,
} from "@/app/(dashboard)/tarefas/actions";
import { TaskForm } from "@/components/tarefas/task-form";
import { PipelineBoard } from "@/components/pipelines/pipeline-board";
import { getDealAlertDays } from "@/components/settings/actions";
import { PipelineList } from "@/components/pipelines/pipeline-list";
import { PipelineSettings } from "@/components/pipelines/pipeline-settings";
import { DealForm } from "@/components/pipelines/deal-form";
import { PipelineAnalytics } from "@/components/pipelines/pipeline-analytics";
import { PipelineForecastCard } from "@/components/pipelines/pipeline-forecast-card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  GitBranch,
  Plus,
  ChevronDown,
  Settings,
  Search,
  User as UserIcon,
  CircleDot,
  ArrowDownUp,
  Snowflake,
  LayoutGrid,
  List,
  Check,
  Building2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@/hooks/use-can";
import { useAuth } from "@/hooks/use-auth";
import { GatedButton } from "@/components/ui/gated-button";
import { cn } from "@/lib/utils";

// Pipeline creation is admin-class (settings-tier write under
// the new RLS); deal creation is operational and only requires
// agent+. The two CTAs gate on different `useCan` capabilities,
// not on different copy.

// Spec-defined seed — name and color per the product spec.
const SPEC_DEFAULT_STAGES = [
  { name: "Novo lead", color: "#3b82f6", position: 0 }, // blue
  { name: "Qualificado", color: "#eab308", position: 1 }, // yellow
  { name: "Proposta enviada", color: "#f97316", position: 2 }, // orange
  { name: "Negociação", color: "#8b5cf6", position: 3 }, // purple
  { name: "Ganho", color: "#22c55e", position: 4 }, // green
];

// Rótulos dos filtros do funil (usados na prévia do Select + itens).
const STATUS_LABELS = {
  all: "Todos os status",
  open: "Em andamento",
  won: "Ganhas",
  lost: "Perdidas",
} as const;
const SORT_LABELS = {
  recent: "Mais recentes",
  value_desc: "Maior valor",
  value_asc: "Menor valor",
  close: "Fechamento previsto",
  name: "Título (A–Z)",
} as const;

// Filtros que FICAM salvos entre visitas (chamado do Rafael: escolher
// "Em andamento" e ele voltar pro padrão a cada entrada). Persistem por
// navegador em localStorage; mudam só quando o humano muda.
const FILTERS_LS_KEY = "fluxia:funil:filtros";
type SavedFilters = {
  status?: keyof typeof STATUS_LABELS;
  sort?: keyof typeof SORT_LABELS;
  view?: "board" | "list";
};
function loadSavedFilters(): SavedFilters {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(FILTERS_LS_KEY);
    const parsed = raw ? (JSON.parse(raw) as SavedFilters) : {};
    return {
      status: parsed.status && parsed.status in STATUS_LABELS ? parsed.status : undefined,
      sort: parsed.sort && parsed.sort in SORT_LABELS ? parsed.sort : undefined,
      view: parsed.view === "list" || parsed.view === "board" ? parsed.view : undefined,
    };
  } catch {
    return {};
  }
}

export default function PipelinesPage() {
  const canEditSettings = useCan("edit-settings");
  const canCreateDeals = useCan("send-messages");
  const { user } = useAuth();

  // Filtros do funil (estilo RD) — dono / status / ordenação / busca. Rodam no
  // cliente sobre os deals já carregados (instantâneo, sem nova query).
  // 'all' | 'mine' | lista de user ids (multi-seleção por responsável, RD).
  const [ownerFilter, setOwnerFilter] = useState<"all" | "mine" | string[]>(
    "all",
  );
  const [ownerMenuOpen, setOwnerMenuOpen] = useState(false);
  // Filtro por empresa (entidade) — 'all' ou um company_id.
  const [companyFilter, setCompanyFilter] = useState<string>("all");
  const [companyMenuOpen, setCompanyMenuOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<
    "all" | "open" | "won" | "lost"
  >("all");
  const [sortBy, setSortBy] = useState<
    "recent" | "value_desc" | "value_asc" | "close" | "name"
  >("recent");
  const [search, setSearch] = useState("");
  // Kanban (board) ⇄ Lista (tabela) — toggle estilo RD.
  const [viewMode, setViewMode] = useState<"board" | "list">("board");

  // Hidrata os filtros salvos APÓS montar (localStorage não existe no SSR —
  // ler no initializer causaria hydration mismatch) e só então passa a salvar
  // as mudanças do humano.
  const filtersHydrated = useRef(false);
  useEffect(() => {
    if (!filtersHydrated.current) {
      filtersHydrated.current = true;
      const saved = loadSavedFilters();
      if (saved.status) setStatusFilter(saved.status);
      if (saved.sort) setSortBy(saved.sort);
      if (saved.view) setViewMode(saved.view);
      return;
    }
    try {
      window.localStorage.setItem(
        FILTERS_LS_KEY,
        JSON.stringify({ status: statusFilter, sort: sortBy, view: viewMode }),
      );
    } catch {
      // navegador sem localStorage (modo privado agressivo) — segue sem salvar
    }
  }, [statusFilter, sortBy, viewMode]);
  // "Esfriando": limite de dias (da conta) + filtro só-esfriando.
  const [staleDays, setStaleDays] = useState(0);
  const [staleOnly, setStaleOnly] = useState(false);

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>("");
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);

  // Limite de "esfriando" da conta (0 = desligado).
  useEffect(() => {
    getDealAlertDays()
      .then(setStaleDays)
      .catch(() => {});
  }, []);

  // Aplica os filtros/ordenação no cliente. O board (contagem + soma por
  // etapa), drag-drop e mutações continuam operando sobre `deals`; só a
  // exibição usa `visibleDeals`.
  const visibleDeals = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = deals.filter((d) => {
      if (ownerFilter === "mine") {
        if (d.assigned_to !== user?.id) return false;
      } else if (Array.isArray(ownerFilter) && ownerFilter.length > 0) {
        if (!d.assigned_to || !ownerFilter.includes(d.assigned_to)) return false;
      }
      if (statusFilter !== "all" && (d.status ?? "open") !== statusFilter)
        return false;
      if (companyFilter !== "all" && d.company_id !== companyFilter)
        return false;
      if (staleOnly) {
        const since = d.stage_changed_at ?? d.created_at;
        const days = since
          ? Math.floor((Date.now() - new Date(since).getTime()) / 86400000)
          : 0;
        const stale =
          staleDays > 0 && (d.status ?? "open") === "open" && days >= staleDays;
        if (!stale) return false;
      }
      if (q) {
        const hay = `${d.title ?? ""} ${d.contact?.name ?? ""} ${
          d.contact?.phone ?? ""
        }`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const val = (d: Deal) => Number(d.value || 0);
    const time = (s?: string) => (s ? new Date(s).getTime() : Infinity);
    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "value_desc":
          return val(b) - val(a);
        case "value_asc":
          return val(a) - val(b);
        case "close":
          return time(a.expected_close_date) - time(b.expected_close_date);
        case "name":
          return (a.title || "").localeCompare(b.title || "");
        case "recent":
        default:
          return (
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          );
      }
    });
  }, [deals, ownerFilter, statusFilter, companyFilter, staleOnly, staleDays, sortBy, search, user?.id]);

  // Empresas presentes nos deals (alimenta o filtro de empresa — Fase 3).
  const companyOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of deals) {
      if (d.company_id && d.company_name) m.set(d.company_id, d.company_name);
    }
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [deals]);

  const companyLabel =
    companyFilter === "all"
      ? "Todas as empresas"
      : (companyOptions.find((c) => c.id === companyFilter)?.name ?? "Empresa");

  // Responsáveis presentes nos deals (alimenta o filtro multi-seleção — RD).
  const owners = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of deals) {
      if (d.assignee?.id)
        m.set(d.assignee.id, d.assignee.full_name || "Sem nome");
    }
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [deals]);

  const ownerLabel =
    ownerFilter === "all"
      ? "Todas as negociações"
      : ownerFilter === "mine"
        ? "Minhas negociações"
        : ownerFilter.length === 0
          ? "Todas as negociações"
          : ownerFilter.length === 1
            ? (owners.find((o) => o.id === ownerFilter[0])?.name ??
              "1 responsável")
            : `${ownerFilter.length} responsáveis`;

  const toggleOwner = (id: string) =>
    setOwnerFilter((prev) => {
      const arr = Array.isArray(prev) ? [...prev] : [];
      const i = arr.indexOf(id);
      if (i >= 0) arr.splice(i, 1);
      else arr.push(id);
      return arr;
    });

  // Batched open-task counts keyed by deal id — one query per board load
  // (no N+1). Drives the per-card task indicator.
  const [taskCounts, setTaskCounts] = useState<Record<string, DealTaskCount>>(
    {},
  );
  // Dicas da IA por negócio (sugestões pendentes + próximo passo) pro card.
  const [aiHints, setAiHints] = useState<Record<string, DealAiHint>>({});
  // Previsão de receita: re-busca quando os negócios/etapas mudam (debounce
  // pra coalescer arrastar/editar) ou quando o funil é atualizado.
  const [forecastNonce, setForecastNonce] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setForecastNonce((n) => n + 1), 400);
    return () => clearTimeout(t);
  }, [deals, stages]);
  // Negócios que TÊM produtos — p/ a métrica "Sem produtos" das estatísticas.
  const [dealsWithProducts, setDealsWithProducts] = useState<Set<string>>(
    new Set(),
  );

  // Reused Tarefas create dialog, prefilled with a deal (+ its contact).
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [taskDeal, setTaskDeal] = useState<Deal | null>(null);

  // Dialog / sheet state
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState("");
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Deal form state is lifted here so both the top-bar "Add Deal" and
  // the per-column "+" trigger the same Sheet.
  const [dealFormOpen, setDealFormOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);
  const [defaultStageId, setDefaultStageId] = useState<string>("");

  // Guard against double-seeding (React StrictMode double-effect in dev).
  const seedAttempted = useRef(false);

  const loadPipelines = useCallback(async () => {
    try {
      return await listPipelines();
    } catch (err) {
      console.error(
        "Failed to load pipelines:",
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  }, []);

  const loadStages = useCallback(async (pipelineId: string) => {
    return listStages(pipelineId).catch(() => []);
  }, []);

  const loadDeals = useCallback(async (pipelineId: string) => {
    return listDeals(pipelineId).catch(() => [] as Deal[]);
  }, []);

  // Batched open-task counts for a set of deals (one query for the board).
  const loadTaskCounts = useCallback(async (dealList: Deal[]) => {
    const ids = dealList.map((d) => d.id);
    if (ids.length === 0) {
      setTaskCounts({});
      setDealsWithProducts(new Set());
      setAiHints({});
      return;
    }
    try {
      const [counts, withProds, hints] = await Promise.all([
        getDealTaskCounts(ids),
        getDealsWithProducts(ids),
        getDealAiHints(ids).catch(() => ({}) as Record<string, DealAiHint>),
      ]);
      setTaskCounts(counts);
      setDealsWithProducts(new Set(withProds));
      setAiHints(hints);
    } catch (err) {
      console.error("Failed to load task counts:", err);
    }
  }, []);

  const seedDefaultPipeline = useCallback(async (): Promise<Pipeline | null> => {
    // Auth + account resolution happen inside the server action —
    // pipelines.account_id is NOT NULL post-017 with no DB default.
    const { pipeline, error } = await createPipelineWithStages(
      "Funil de vendas",
      SPEC_DEFAULT_STAGES,
    );
    if (error || !pipeline) {
      console.error("Failed to seed pipeline:", error);
      return null;
    }
    return pipeline;
  }, []);

  // Initial load + seed-if-empty
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      let list = await loadPipelines();

      if (list.length === 0 && !seedAttempted.current) {
        seedAttempted.current = true;
        const seeded = await seedDefaultPipeline();
        if (seeded) list = await loadPipelines();
      }

      if (cancelled) return;
      setPipelines(list);
      if (list.length > 0) {
        setSelectedPipelineId((prev) =>
          prev && list.some((p) => p.id === prev) ? prev : list[0].id,
        );
      } else {
        setSelectedPipelineId("");
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadPipelines, seedDefaultPipeline]);

  // Load stages + deals whenever selected pipeline changes.
  // Clearing on no-selection is a legitimate sync with URL/prop
  // state; the load completion uses async setters inside promise
  // callbacks (not synchronous in the effect body).
  useEffect(() => {
    if (!selectedPipelineId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStages([]);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDeals([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const [s, d] = await Promise.all([
        loadStages(selectedPipelineId),
        loadDeals(selectedPipelineId),
      ]);
      if (cancelled) return;
      setStages(s);
      setDeals(d);
      void loadTaskCounts(d);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPipelineId, loadStages, loadDeals, loadTaskCounts]);

  const refreshPipelines = useCallback(async () => {
    const list = await loadPipelines();
    setPipelines(list);
    if (list.length === 0) setSelectedPipelineId("");
    else if (!list.some((p) => p.id === selectedPipelineId))
      setSelectedPipelineId(list[0].id);
  }, [loadPipelines, selectedPipelineId]);

  const refreshStages = useCallback(async () => {
    if (!selectedPipelineId) return;
    setStages(await loadStages(selectedPipelineId));
  }, [loadStages, selectedPipelineId]);

  const refreshDeals = useCallback(async () => {
    if (!selectedPipelineId) return;
    const d = await loadDeals(selectedPipelineId);
    setDeals(d);
    void loadTaskCounts(d);
  }, [loadDeals, loadTaskCounts, selectedPipelineId]);

  // Atualizar o funil inteiro (etapas + negócios) — botão manual no header, pra
  // pegar o que mudou em outra aba/pessoa sem recarregar a página.
  const [refreshing, setRefreshing] = useState(false);
  const handleRefreshBoard = useCallback(async () => {
    if (!selectedPipelineId || refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([refreshStages(), refreshDeals()]);
    } finally {
      setRefreshing(false);
    }
  }, [selectedPipelineId, refreshing, refreshStages, refreshDeals]);

  // Open the reused TaskForm prefilled with the deal (+ its contact).
  const handleCreateTask = useCallback((deal: Deal) => {
    setTaskDeal(deal);
    setTaskFormOpen(true);
  }, []);

  // After creating a task from a card, refresh the badges (counts).
  const handleTaskSaved = useCallback(() => {
    void loadTaskCounts(deals);
  }, [deals, loadTaskCounts]);

  const handleDealMoved = useCallback(
    async (dealId: string, newStageId: string) => {
      // Optimistic update — board already animated; just persist.
      setDeals((prev) =>
        prev.map((d) => (d.id === dealId ? { ...d, stage_id: newStageId } : d)),
      );
      const { error } = await moveDealToStage(dealId, newStageId);
      if (error) {
        toast.error("Não foi possível mover o negócio");
        refreshDeals();
      }
    },
    [refreshDeals],
  );

  const handleAddDeal = useCallback(
    (stageId?: string) => {
      setEditingDeal(null);
      setDefaultStageId(stageId ?? stages[0]?.id ?? "");
      setDealFormOpen(true);
    },
    [stages],
  );

  const handleEditDeal = useCallback((deal: Deal) => {
    setEditingDeal(deal);
    setDefaultStageId(deal.stage_id);
    setDealFormOpen(true);
  }, []);

  async function handleCreatePipeline() {
    const name = newPipelineName.trim();
    if (!name) return;
    setCreating(true);

    // Auth + account resolution happen inside the server action —
    // pipelines.account_id is NOT NULL post-017 with no DB default.
    const { pipeline, error } = await createPipelineWithStages(
      name,
      SPEC_DEFAULT_STAGES,
    );

    if (error || !pipeline) {
      toast.error("Não foi possível criar o funil");
      setCreating(false);
      return;
    }

    setNewPipelineName("");
    setNewPipelineOpen(false);
    setSelectedPipelineId(pipeline.id);
    await refreshPipelines();
    setCreating(false);
    toast.success("Funil criado");
  }

  const selectedPipeline = pipelines.find((p) => p.id === selectedPipelineId);

  // Picker options (label pre-selects the deal/contact) for the reused
  // TaskForm opened from a Kanban card.
  const taskDealOptions: PickerOption[] = taskDeal
    ? [
        {
          id: taskDeal.id,
          label: taskDeal.title,
          sublabel: selectedPipeline?.name ?? null,
        },
      ]
    : [];
  const taskContactOptions: PickerOption[] = taskDeal?.contact_id
    ? [
        {
          id: taskDeal.contact_id,
          label: taskDeal.contact?.name || taskDeal.contact?.phone || "Cliente",
          sublabel: taskDeal.contact?.phone ?? null,
        },
      ]
    : [];

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-9 w-28 animate-pulse rounded-lg bg-muted" />
        </div>
        <div className="flex gap-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-96 w-72 animate-pulse rounded-xl bg-muted/50" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* Pipeline selector dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors data-[popup-open]:bg-muted"
            >
              <GitBranch className="h-4 w-4 text-primary" />
              <span className="font-semibold">
                {selectedPipeline?.name ?? "Selecionar funil"}
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-64 border-border bg-popover text-popover-foreground"
            >
              {pipelines.length === 0 && (
                <DropdownMenuItem disabled className="text-muted-foreground">
                  Nenhum funil ainda
                </DropdownMenuItem>
              )}
              {pipelines.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() => setSelectedPipelineId(p.id)}
                  className={
                    p.id === selectedPipelineId
                      ? "text-primary"
                      : "text-popover-foreground"
                  }
                >
                  <GitBranch className="mr-2 h-3.5 w-3.5" />
                  {p.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator className="bg-border" />
              {selectedPipeline && (
                <DropdownMenuItem
                  onClick={() => setSettingsOpen(true)}
                  className="text-popover-foreground"
                >
                  <Settings className="mr-2 h-3.5 w-3.5" />
                  Gerenciar funis
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleRefreshBoard()}
            disabled={!selectedPipelineId || refreshing}
            title="Atualizar funil (etapas e negócios)"
            aria-label="Atualizar funil"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          </button>
          <GatedButton
            variant="outline"
            canAct={canEditSettings}
            gateReason="criar funis"
            onClick={() => setNewPipelineOpen(true)}
            className="border-border bg-card text-foreground hover:bg-muted"
          >
            <Plus className="mr-1 h-4 w-4" />
            Novo funil
          </GatedButton>
          <GatedButton
            canAct={canCreateDeals}
            gateReason="criar negócios"
            disabled={!selectedPipelineId || stages.length === 0}
            onClick={() => handleAddDeal()}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 h-4 w-4" />
            Novo negócio
          </GatedButton>
        </div>
      </div>

      {/* Board */}
      {pipelines.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20">
          <GitBranch className="h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-medium text-foreground">
            Nenhum funil ainda
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Crie um funil para começar a acompanhar seus negócios
          </p>
          <GatedButton
            canAct={canEditSettings}
            gateReason="criar funis"
            onClick={() => setNewPipelineOpen(true)}
            className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 h-4 w-4" />
            Criar funil
          </GatedButton>
        </div>
      ) : (
        <>
          {/* Barra de filtros do funil (estilo RD): busca, dono, status,
              ordenação + contador. Roda no cliente sobre os deals carregados. */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {/* Toggle Kanban ⇄ Lista */}
            <div className="flex items-center rounded-md border border-border bg-card p-0.5">
              <button
                type="button"
                onClick={() => setViewMode("board")}
                aria-label="Visão Kanban"
                title="Kanban"
                className={`flex h-8 w-8 items-center justify-center rounded transition-colors ${
                  viewMode === "board"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                }`}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode("list")}
                aria-label="Visão Lista"
                title="Lista"
                className={`flex h-8 w-8 items-center justify-center rounded transition-colors ${
                  viewMode === "list"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                }`}
              >
                <List className="h-4 w-4" />
              </button>
            </div>

            <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar negócio ou contato…"
                className="h-9 border-border bg-card pl-8 text-sm"
              />
            </div>

            {/* Dono: multi-seleção por responsável (estilo RD). */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setOwnerMenuOpen((v) => !v)}
                className="flex h-9 w-[200px] items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground hover:bg-muted"
              >
                <UserIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate text-left">{ownerLabel}</span>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
              {ownerMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setOwnerMenuOpen(false)}
                  />
                  <div className="absolute left-0 z-50 mt-1 w-64 rounded-md border border-border bg-popover p-1 text-sm shadow-xl">
                    <button
                      type="button"
                      onClick={() => {
                        setOwnerFilter("all");
                        setOwnerMenuOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-muted",
                        ownerFilter === "all" && "text-primary",
                      )}
                    >
                      Todas as negociações
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOwnerFilter("mine");
                        setOwnerMenuOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-muted",
                        ownerFilter === "mine" && "text-primary",
                      )}
                    >
                      Minhas negociações
                    </button>
                    {owners.length > 0 && (
                      <>
                        <div className="my-1 border-t border-border" />
                        <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Responsáveis
                        </p>
                        <div className="max-h-52 overflow-y-auto">
                          {owners.map((o) => {
                            const sel =
                              Array.isArray(ownerFilter) &&
                              ownerFilter.includes(o.id);
                            return (
                              <button
                                key={o.id}
                                type="button"
                                onClick={() => toggleOwner(o.id)}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
                              >
                                <span
                                  className={cn(
                                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                                    sel
                                      ? "border-primary bg-primary text-primary-foreground"
                                      : "border-border",
                                  )}
                                >
                                  {sel && <Check className="h-3 w-3" />}
                                </span>
                                <span className="truncate">{o.name}</span>
                              </button>
                            );
                          })}
                        </div>
                        {Array.isArray(ownerFilter) &&
                          ownerFilter.length > 0 && (
                            <button
                              type="button"
                              onClick={() => setOwnerFilter("all")}
                              className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                              Limpar seleção
                            </button>
                          )}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Empresa (entidade) — filtro single-select. Some quando não há
                nenhuma empresa nos negócios (mantém a barra limpa). */}
            {companyOptions.length > 0 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setCompanyMenuOpen((v) => !v)}
                  className="flex h-9 w-[190px] items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground hover:bg-muted"
                >
                  <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate text-left">
                    {companyLabel}
                  </span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
                {companyMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setCompanyMenuOpen(false)}
                    />
                    <div className="absolute left-0 z-50 mt-1 w-64 rounded-md border border-border bg-popover p-1 text-sm shadow-xl">
                      <button
                        type="button"
                        onClick={() => {
                          setCompanyFilter("all");
                          setCompanyMenuOpen(false);
                        }}
                        className={cn(
                          "flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-muted",
                          companyFilter === "all" && "text-primary",
                        )}
                      >
                        Todas as empresas
                      </button>
                      <div className="my-1 border-t border-border" />
                      <div className="max-h-60 overflow-y-auto">
                        {companyOptions.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => {
                              setCompanyFilter(c.id);
                              setCompanyMenuOpen(false);
                            }}
                            className={cn(
                              "flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-muted",
                              companyFilter === c.id && "text-primary",
                            )}
                          >
                            <span className="truncate">{c.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            <Select
              value={statusFilter}
              onValueChange={(v) =>
                v && setStatusFilter(v as "all" | "open" | "won" | "lost")
              }
            >
              <SelectTrigger className="h-9 w-[165px] border-border bg-card text-sm text-foreground">
                <CircleDot className="h-4 w-4 text-muted-foreground" />
                <SelectValue>
                  {(v) => STATUS_LABELS[v as keyof typeof STATUS_LABELS]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="border-border bg-popover">
                <SelectItem value="all">{STATUS_LABELS.all}</SelectItem>
                <SelectItem value="open">{STATUS_LABELS.open}</SelectItem>
                <SelectItem value="won">{STATUS_LABELS.won}</SelectItem>
                <SelectItem value="lost">{STATUS_LABELS.lost}</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={sortBy}
              onValueChange={(v) =>
                v &&
                setSortBy(
                  v as "recent" | "value_desc" | "value_asc" | "close" | "name",
                )
              }
            >
              <SelectTrigger className="h-9 w-[185px] border-border bg-card text-sm text-foreground">
                <ArrowDownUp className="h-4 w-4 text-muted-foreground" />
                <SelectValue>
                  {(v) => SORT_LABELS[v as keyof typeof SORT_LABELS]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="border-border bg-popover">
                <SelectItem value="recent">{SORT_LABELS.recent}</SelectItem>
                <SelectItem value="value_desc">
                  {SORT_LABELS.value_desc}
                </SelectItem>
                <SelectItem value="value_asc">
                  {SORT_LABELS.value_asc}
                </SelectItem>
                <SelectItem value="close">{SORT_LABELS.close}</SelectItem>
                <SelectItem value="name">{SORT_LABELS.name}</SelectItem>
              </SelectContent>
            </Select>

            {staleDays > 0 && (
              <button
                type="button"
                onClick={() => setStaleOnly((v) => !v)}
                title="Mostrar só os negócios parados na etapa (esfriando)"
                className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors ${
                  staleOnly
                    ? "border-amber-500/50 bg-amber-500/10 text-amber-600"
                    : "border-border bg-card text-muted-foreground hover:text-foreground"
                }`}
              >
                <Snowflake className="h-4 w-4" />
                Esfriando
              </button>
            )}

            <span className="ml-auto shrink-0 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
              {visibleDeals.length}{" "}
              {visibleDeals.length === 1 ? "negócio" : "negócios"}
            </span>
          </div>

          <PipelineForecastCard
            pipelineId={selectedPipelineId}
            refreshKey={forecastNonce}
          />
          <PipelineAnalytics stages={stages} deals={deals} />
          {viewMode === "list" ? (
            <PipelineList
              stages={stages}
              deals={visibleDeals}
              taskCounts={taskCounts}
            />
          ) : (
            <PipelineBoard
              stages={stages}
              deals={visibleDeals}
              onDealMoved={handleDealMoved}
              onAddDeal={handleAddDeal}
              onEditDeal={handleEditDeal}
              taskCounts={taskCounts}
              dealsWithProducts={dealsWithProducts}
              onCreateTask={handleCreateTask}
              staleDays={staleDays}
              aiHints={aiHints}
            />
          )}
        </>
      )}

      {/* New Pipeline Dialog */}
      <Dialog open={newPipelineOpen} onOpenChange={setNewPipelineOpen}>
        <DialogContent className="sm:max-w-sm bg-popover border-border">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">Novo funil</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Label className="text-muted-foreground">Nome do funil</Label>
            <Input
              value={newPipelineName}
              onChange={(e) => setNewPipelineName(e.target.value)}
              placeholder="ex.: Vendas corporativas"
              className="mt-2 bg-muted border-border text-foreground"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreatePipeline();
              }}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              As etapas padrão (Novo lead → Ganho) serão criadas automaticamente.
            </p>
          </div>
          <DialogFooter className="bg-popover/50 border-border">
            <Button
              variant="outline"
              onClick={() => setNewPipelineOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
            <Button
              onClick={handleCreatePipeline}
              disabled={creating || !newPipelineName.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {creating ? "Criando..." : "Criar funil"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pipeline Settings */}
      {selectedPipeline && (
        <PipelineSettings
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          pipeline={selectedPipeline}
          stages={stages}
          onPipelinesChanged={refreshPipelines}
          onStagesChanged={refreshStages}
          onCreateNewPipeline={() => {
            setSettingsOpen(false);
            setNewPipelineOpen(true);
          }}
        />
      )}

      {/* Deal Form (Sheet) */}
      <DealForm
        open={dealFormOpen}
        onOpenChange={setDealFormOpen}
        deal={editingDeal}
        pipelineId={selectedPipelineId}
        stages={stages}
        defaultStageId={defaultStageId}
        onSaved={refreshDeals}
      />

      {/* Task creator — reuses the Tarefas TaskForm dialog, prefilled with
          the Kanban card (deal) AND its contact so the new task links to
          both. On save we refresh the per-card task counts. */}
      <TaskForm
        open={taskFormOpen}
        onOpenChange={setTaskFormOpen}
        contacts={taskContactOptions}
        deals={taskDealOptions}
        prefillDealId={taskDeal?.id ?? null}
        prefillContactId={taskDeal?.contact_id ?? null}
        onSaved={handleTaskSaved}
      />
    </div>
  );
}
