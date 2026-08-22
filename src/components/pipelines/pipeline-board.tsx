"use client";

import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  closestCorners,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { Deal, PipelineStage } from "@/types";
import type { DealTaskCount } from "@/app/(dashboard)/tarefas/actions";
import { DealCard } from "./deal-card";
import { Button } from "@/components/ui/button";
import { Plus, Megaphone } from "lucide-react";
import { StageBroadcastDialog } from "./stage-broadcast-dialog";
import { useAuth } from "@/hooks/use-auth";
import { useCrmCallingEnabled } from "@/hooks/use-crm-calling";
import { formatCurrency } from "@/lib/currency";

interface PipelineBoardProps {
  stages: PipelineStage[];
  deals: Deal[];
  onDealMoved: (dealId: string, newStageId: string) => void;
  onAddDeal: (stageId: string) => void;
  onEditDeal: (deal: Deal) => void;
  /** Batched open-task counts keyed by deal id (for the card indicator). */
  taskCounts?: Record<string, DealTaskCount>;
  /** IDs dos negócios que têm produtos — p/ a métrica "Sem produtos". */
  dealsWithProducts?: Set<string>;
  /** Open the reused TaskForm prefilled with a deal (+ its contact). */
  onCreateTask?: (deal: Deal) => void;
  /** Dias parado na etapa que marcam "esfriando" (0/undefined = desligado). */
  staleDays?: number;
}

export function PipelineBoard({
  stages,
  deals,
  onDealMoved,
  onAddDeal,
  onEditDeal,
  taskCounts,
  dealsWithProducts,
  onCreateTask,
  staleDays,
}: PipelineBoardProps) {
  const { defaultCurrency } = useAuth();
  // Resolvido UMA vez aqui e passado pra baixo (StageColumn → card), pra não
  // fazer 1 fetch de "ligações no CRM" por card do board.
  const callingEnabled = useCrmCallingEnabled();
  const [activeDealId, setActiveDealId] = useState<string | null>(null);
  // Estatísticas por coluna (estilo RD) — toggle global mostra/esconde.
  const [showStats, setShowStats] = useState(false);

  const sortedStages = useMemo(
    () => [...stages].sort((a, b) => a.position - b.position),
    [stages],
  );

  const dealsByStage = useMemo(() => {
    const map = new Map<string, Deal[]>();
    for (const stage of sortedStages) map.set(stage.id, []);
    for (const deal of deals) {
      const bucket = map.get(deal.stage_id);
      if (bucket) bucket.push(deal);
    }
    return map;
  }, [sortedStages, deals]);

  const sensors = useSensors(
    // 5px activation distance avoids clicks being interpreted as drags.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Keyboard drag support: focus a card, Space to pick up, arrows to move,
    // Space to drop, Escape to cancel.
    useSensor(KeyboardSensor),
  );

  const activeDeal = activeDealId
    ? deals.find((d) => d.id === activeDealId) ?? null
    : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveDealId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDealId(null);
    const { active, over } = event;
    if (!over) return;
    const dealId = String(active.id);
    const targetStageId = String(over.id);

    const deal = deals.find((d) => d.id === dealId);
    if (!deal || deal.stage_id === targetStageId) return;
    if (!sortedStages.some((s) => s.id === targetStageId)) return;

    onDealMoved(dealId, targetStageId);
  }

  function handleDragCancel() {
    setActiveDealId(null);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {/* Toggle das estatísticas por coluna (estilo RD). */}
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          onClick={() => setShowStats((v) => !v)}
          className="rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
        >
          {showStats ? "Esconder estatísticas" : "Estatísticas por etapa"}
        </button>
      </div>

      {/* snap-x + snap-mandatory on mobile so swipes land the next
          stage cleanly at the viewport edge instead of mid-column.
          Disabled on lg+ where snapping would interfere with the
          natural layout. The board can still overflow horizontally on
          lg+ once a pipeline has many stages (columns keep a 260px
          min-width), so a thin scrollbar stays visible on desktop. */}
      <div className="pipeline-scroll flex snap-x snap-mandatory gap-3 overflow-x-auto pb-4 lg:snap-none">
        {sortedStages.map((stage) => {
          const stageDeals = dealsByStage.get(stage.id) ?? [];
          const totalValue = stageDeals.reduce(
            (s, d) => s + Number(d.value || 0),
            0,
          );
          return (
            <StageColumn
              key={stage.id}
              stage={stage}
              deals={stageDeals}
              callingEnabled={callingEnabled} staleDays={staleDays}
              totalValue={totalValue}
              currency={defaultCurrency}
              onAddDeal={onAddDeal}
              onEditDeal={onEditDeal}
              taskCounts={taskCounts}
              dealsWithProducts={dealsWithProducts}
              onCreateTask={onCreateTask}
              showStats={showStats}
            />
          );
        })}
      </div>

      <DragOverlay
        dropAnimation={{
          duration: 200,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
        }}
      >
        {activeDeal ? (
          <div className="opacity-90">
            <DealCard
              deal={activeDeal}
              stage={
                sortedStages.find((s) => s.id === activeDeal.stage_id) ?? null
              }
              onEdit={() => {}}
              isOverlay
              callingEnabled={callingEnabled} staleDays={staleDays}
            />
          </div>
        ) : null}
      </DragOverlay>

      <style jsx>{`
        .pipeline-scroll {
          scroll-behavior: smooth;
        }
        /* On touch devices the peek/snap layout already signals there's
           more to swipe, so the scrollbar is hidden for a clean look.
           On desktop (mouse) the board can overflow with many stages
           and there is no peek hint, so keep a thin, themed scrollbar
           visible to make the overflow discoverable and usable. */
        @media (hover: none), (pointer: coarse) {
          .pipeline-scroll::-webkit-scrollbar {
            height: 0;
            display: none;
          }
          .pipeline-scroll {
            scrollbar-width: none;
          }
        }
        @media (hover: hover) and (pointer: fine) {
          .pipeline-scroll {
            scrollbar-width: thin;
            scrollbar-color: var(--border) transparent;
          }
          .pipeline-scroll::-webkit-scrollbar {
            height: 8px;
          }
          .pipeline-scroll::-webkit-scrollbar-track {
            background: transparent;
          }
          .pipeline-scroll::-webkit-scrollbar-thumb {
            background-color: var(--border);
            border-radius: 9999px;
          }
          .pipeline-scroll::-webkit-scrollbar-thumb:hover {
            background-color: var(--muted-foreground);
          }
        }
      `}</style>
    </DndContext>
  );
}

function StageColumn({
  stage,
  deals,
  totalValue,
  currency,
  onAddDeal,
  onEditDeal,
  taskCounts,
  dealsWithProducts,
  onCreateTask,
  showStats,
  callingEnabled,
  staleDays,
}: {
  stage: PipelineStage;
  deals: Deal[];
  totalValue: number;
  currency: string;
  onAddDeal: (stageId: string) => void;
  onEditDeal: (deal: Deal) => void;
  taskCounts?: Record<string, DealTaskCount>;
  dealsWithProducts?: Set<string>;
  onCreateTask?: (deal: Deal) => void;
  showStats?: boolean;
  callingEnabled?: boolean;
  staleDays?: number;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const [bcastOpen, setBcastOpen] = useState(false);

  // Estatísticas por coluna (estilo RD) — calculadas dos deals + taskCounts.
  const stats = useMemo(() => {
    const open = deals.filter((d) => (d.status ?? "open") === "open");
    const daysInStage = (d: Deal) => {
      const s = d.stage_changed_at ?? d.created_at;
      return s
        ? Math.floor((Date.now() - new Date(s).getTime()) / 86400000)
        : 0;
    };
    return {
      emAndamento: open.length,
      semTarefas: open.filter((d) => !(taskCounts?.[d.id]?.open ?? 0)).length,
      atrasadas: open.filter((d) => (taskCounts?.[d.id]?.overdue ?? 0) > 0)
        .length,
      // "Esfriando": aberto, parado há 7+ dias na etapa e sem tarefa aberta.
      esfriando: open.filter(
        (d) => daysInStage(d) >= 7 && !(taskCounts?.[d.id]?.open ?? 0),
      ).length,
      semProdutos: open.filter((d) => !dealsWithProducts?.has(d.id)).length,
    };
  }, [deals, taskCounts, dealsWithProducts]);

  return (
    // On mobile each column is `w-[85vw]` (with a reasonable min/max)
    // so the next column's edge peeks in — a "there's more here" hint.
    // snap-start lands each column cleanly when swiping. On lg+ we
    // restore the flex-1 share-the-row behavior. The droppable ref is
    // on the inner messages region below — intentionally NOT here, so
    // a drag over the column header doesn't highlight the whole column.
    <div className="flex w-[85vw] min-w-[260px] max-w-[320px] shrink-0 snap-start flex-col rounded-xl border border-border bg-card/60 p-4 lg:w-auto lg:max-w-none lg:flex-1 lg:basis-[260px] lg:shrink lg:snap-none">
      {/* 3px colored top border — sits above the column's padding */}
      <div
        className="-mx-4 -mt-4 h-[3px] rounded-t-xl"
        style={{ backgroundColor: stage.color }}
      />
      <div className="flex items-center justify-between pt-3">
        <h3 className="truncate text-sm font-semibold text-foreground">
          {stage.name}
        </h3>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setBcastOpen(true)}
            title="Disparar mensagem para os leads desta etapa"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
            aria-label="Disparar para a etapa"
          >
            <Megaphone className="h-3.5 w-3.5" />
          </button>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {deals.length}
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {formatCurrency(totalValue, currency)}
      </p>

      {/* Estatísticas da etapa (estilo RD) — toggle global. */}
      {showStats && (
        <div className="mt-2 space-y-0.5 rounded-md border border-border bg-background/60 p-2 text-[11px]">
          <StatRow label="Em andamento" value={stats.emAndamento} />
          <StatRow label="Esfriando" value={stats.esfriando} warn />
          <StatRow label="Sem tarefas" value={stats.semTarefas} warn />
          <StatRow
            label="Com tarefas atrasadas"
            value={stats.atrasadas}
            danger
          />
          <StatRow label="Sem produtos" value={stats.semProdutos} warn />
        </div>
      )}

      <div
        ref={setNodeRef}
        className={`mt-3 flex flex-1 flex-col gap-2 rounded-lg transition-all ${
          isOver
            ? "bg-primary/5 outline outline-2 outline-dashed outline-primary outline-offset-2"
            : ""
        }`}
      >
        {deals.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border-2 border-dashed border-border py-10 text-xs text-muted-foreground">
            Solte um negócio aqui
          </div>
        ) : (
          deals.map((deal) => (
            <DraggableDealCard
              key={deal.id}
              deal={deal}
              stage={stage}
              onEdit={onEditDeal}
              taskCount={taskCounts?.[deal.id]}
              onCreateTask={onCreateTask}
              callingEnabled={callingEnabled} staleDays={staleDays}
            />
          ))
        )}
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => onAddDeal(stage.id)}
        className="mt-3 w-full justify-start border border-dashed border-border bg-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground"
      >
        <Plus className="mr-1 h-3 w-3" />
        Novo negócio
      </Button>

      <StageBroadcastDialog
        stageId={stage.id}
        stageName={stage.name}
        open={bcastOpen}
        onOpenChange={setBcastOpen}
      />
    </div>
  );
}

function DraggableDealCard({
  deal,
  stage,
  onEdit,
  taskCount,
  onCreateTask,
  callingEnabled,
  staleDays,
}: {
  deal: Deal;
  stage: PipelineStage;
  onEdit: (deal: Deal) => void;
  taskCount?: DealTaskCount;
  onCreateTask?: (deal: Deal) => void;
  callingEnabled?: boolean;
  staleDays?: number;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: deal.id,
    // Funil aberto: não dá pra arrastar deal atribuído a outra pessoa (travado).
    disabled: deal.read_blocked,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{ opacity: isDragging ? 0.3 : 1, touchAction: "none" }}
    >
      <DealCard
        deal={deal}
        stage={stage}
        onEdit={onEdit}
        taskCount={taskCount}
        onCreateTask={onCreateTask}
        callingEnabled={callingEnabled} staleDays={staleDays}
      />
    </div>
  );
}

// Uma linha do painel de estatísticas por etapa (label · valor colorido).
function StatRow({
  label,
  value,
  warn,
  danger,
}: {
  label: string;
  value: number;
  warn?: boolean;
  danger?: boolean;
}) {
  const color =
    value === 0
      ? "text-muted-foreground/50"
      : danger
        ? "text-red-500"
        : warn
          ? "text-amber-500"
          : "text-foreground";
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium tabular-nums ${color}`}>
        {value || "–"}
      </span>
    </div>
  );
}
