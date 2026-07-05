"use client";

// ============================================================
// TaskMiniList — a compact list of a contact's / deal's tasks, used
// in the inbox sidebar "Tarefas" section and the Kanban card task
// popover. Each row shows the title, due date (overdue in RED,
// "vence hoje" in amber), a "concluir" toggle (toggleTaskDone) and a
// delete button. pt-BR, dark theme. Does NOT own the create dialog —
// callers wire the reused TaskForm and pass onChanged to refetch.
// ============================================================

import { useState } from "react";
import { toast } from "sonner";
import {
  toggleTaskDone,
  deleteTask,
  type TaskLite,
} from "@/app/(dashboard)/tarefas/actions";
import { Check, Circle, Trash2, Loader2, CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";

/** Format a due date as dd/MM · HH:mm, dropping the time when midnight. */
function formatDue(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  return hasTime ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

/** True when the due date falls on the local calendar today. */
function isDueToday(value: string): boolean {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

interface TaskMiniListProps {
  tasks: TaskLite[];
  /** Refetch the list after a toggle/delete mutates a task. */
  onChanged: () => void;
  /** Copy shown when there are no tasks yet. */
  emptyLabel?: string;
}

export function TaskMiniList({
  tasks,
  onChanged,
  emptyLabel = "Nenhuma tarefa.",
}: TaskMiniListProps) {
  // Track the id currently mutating so only that row shows a spinner.
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleToggle(id: string) {
    setBusyId(id);
    try {
      const res = await toggleTaskDone(id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id: string) {
    setBusyId(id);
    try {
      const { error } = await deleteTask(id);
      if (error) {
        toast.error(error);
        return;
      }
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  if (tasks.length === 0) {
    return <p className="px-1 text-xs text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-1.5">
      {tasks.map((task) => {
        const done = task.status === "done";
        const cancelled = task.status === "cancelled";
        const busy = busyId === task.id;
        const dueToday = task.due_at && !task.overdue && isDueToday(task.due_at);
        return (
          <div
            key={task.id}
            className="group flex items-start gap-2 rounded-lg bg-muted px-2.5 py-2"
          >
            <button
              type="button"
              onClick={() => void handleToggle(task.id)}
              disabled={busy}
              aria-label={done ? "Reabrir tarefa" : "Concluir tarefa"}
              title={done ? "Reabrir" : "Concluir"}
              className={cn(
                "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                done
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-muted-foreground/50 text-transparent hover:border-primary hover:text-primary",
              )}
            >
              {busy ? (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              ) : done ? (
                <Check className="h-3 w-3" />
              ) : (
                <Circle className="h-2 w-2 fill-current" />
              )}
            </button>

            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-xs leading-snug text-foreground",
                  (done || cancelled) &&
                    "text-muted-foreground line-through",
                )}
              >
                {task.title}
              </p>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                {task.due_at ? (
                  <span
                    className={cn(
                      "flex items-center gap-1",
                      task.overdue
                        ? "text-red-400"
                        : dueToday
                          ? "text-amber-400"
                          : "text-muted-foreground",
                    )}
                  >
                    <CalendarClock className="h-2.5 w-2.5" />
                    {task.overdue
                      ? `Atrasada · ${formatDue(task.due_at)}`
                      : dueToday
                        ? "Vence hoje"
                        : formatDue(task.due_at)}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Sem prazo</span>
                )}
                {task.type && (
                  <span className="rounded-full bg-background px-1.5 py-0.5 text-[9px] text-muted-foreground">
                    {task.type}
                  </span>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => void handleDelete(task.id)}
              disabled={busy}
              aria-label="Excluir tarefa"
              title="Excluir"
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
