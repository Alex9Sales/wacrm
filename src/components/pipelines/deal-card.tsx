"use client";

import type { Deal, PipelineStage } from "@/types";
import type { DealTaskCount } from "@/app/(dashboard)/tarefas/actions";
import { Calendar, Check, X, ListTodo, Plus } from "lucide-react";
import { formatCurrency } from "@/lib/currency";

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
  /** Open-task counts for this deal (from a batched board query). */
  taskCount?: DealTaskCount;
  /** Open the reused TaskForm prefilled with this deal (+ its contact). */
  onCreateTask?: (deal: Deal) => void;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function initials(name?: string, fallback?: string) {
  const source = (name || fallback || "?").trim();
  if (!source) return "?";
  return source.charAt(0).toUpperCase();
}

export function DealCard({
  deal,
  stage,
  isOverlay,
  taskCount,
  onCreateTask,
}: DealCardProps) {
  const contactLabel = deal.contact?.name || deal.contact?.phone || "No contact";
  const assigneeLabel = deal.assignee?.full_name || null;
  const openTasks = taskCount?.open ?? 0;
  const hasOverdue = (taskCount?.overdue ?? 0) > 0;

  return (
    <button
      type="button"
      onClick={(e) => {
        // `onClick` still fires after a non-drag tap because the PointerSensor
        // requires 5px movement before it counts as a drag. Abre a página de
        // detalhe do negócio (estilo RD), não mais o mini-diálogo.
        if (isOverlay) return;
        e.stopPropagation();
        window.location.href = `/pipelines/${deal.id}`;
      }}
      className={`group relative w-full cursor-pointer rounded-xl border border-border/50 bg-muted/70 pl-4 pr-3 py-3 text-left shadow-sm transition-all ${
        isOverlay
          ? "shadow-xl"
          : "hover:-translate-y-0.5 hover:border-border hover:bg-muted hover:shadow-lg"
      }`}
    >
      {/* 4px left accent bar using stage color */}
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-1 rounded-l-xl"
        style={{ backgroundColor: stage?.color ?? "#94a3b8" }}
      />

      <div className="flex items-start justify-between gap-2">
        <h4 className="flex-1 text-sm font-semibold leading-snug text-foreground break-words">
          {deal.title}
        </h4>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Open-task indicator — count + red dot when any is overdue.
              Clicking it opens the same create-task dialog (a lightweight
              entry point to the deal's tasks). */}
          {!isOverlay && openTasks > 0 && (
            <span
              role={onCreateTask ? "button" : undefined}
              tabIndex={onCreateTask ? 0 : undefined}
              aria-label={`${openTasks} tarefa(s) aberta(s)${hasOverdue ? ", com atraso" : ""}`}
              title={
                hasOverdue
                  ? `${openTasks} tarefa(s) aberta(s) · com atraso`
                  : `${openTasks} tarefa(s) aberta(s)`
              }
              onClick={(e) => {
                if (!onCreateTask) return;
                e.stopPropagation();
                onCreateTask(deal);
              }}
              onKeyDown={(e) => {
                if (!onCreateTask) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onCreateTask(deal);
                }
              }}
              className={`relative inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                hasOverdue
                  ? "bg-red-500/15 text-red-400"
                  : "bg-primary/15 text-primary"
              }`}
            >
              <ListTodo className="h-3 w-3" />
              {openTasks}
              {hasOverdue && (
                <span
                  aria-hidden
                  className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-red-500"
                />
              )}
            </span>
          )}

          {/* "criar tarefa" — appears on card hover; opens the reused
              TaskForm prefilled with this deal (+ its contact). */}
          {!isOverlay && onCreateTask && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Criar tarefa"
              title="Criar tarefa"
              onClick={(e) => {
                e.stopPropagation();
                onCreateTask(deal);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onCreateTask(deal);
                }
              }}
              className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100"
            >
              <Plus className="h-3.5 w-3.5" />
            </span>
          )}

          {deal.status === "won" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
              <Check className="h-3 w-3" />
              Won
            </span>
          )}
          {deal.status === "lost" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-400">
              <X className="h-3 w-3" />
              Lost
            </span>
          )}
        </div>
      </div>

      {/* Contact row */}
      <div className="mt-2 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
          {initials(deal.contact?.name, deal.contact?.phone)}
        </span>
        <span className="truncate text-xs text-muted-foreground">{contactLabel}</span>
      </div>

      <div className="mt-2 flex items-center justify-between">
        <span className="text-sm font-bold text-primary">
          {formatCurrency(deal.value, deal.currency)}
        </span>
        {deal.expected_close_date && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Calendar className="h-3 w-3" />
            {formatDate(deal.expected_close_date)}
          </span>
        )}
      </div>

      {assigneeLabel && (
        <div className="mt-2 flex items-center justify-end">
          <span
            title={assigneeLabel}
            className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
          >
            {initials(assigneeLabel)}
          </span>
        </div>
      )}
    </button>
  );
}
