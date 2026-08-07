"use client";

import { useMemo } from "react";
import type { Deal, PipelineStage } from "@/types";
import type { DealTaskCount } from "@/app/(dashboard)/tarefas/actions";
import { formatCurrency } from "@/lib/currency";
import { ContactAvatar } from "@/components/inbox/contact-avatar";
import { Check, X, ListTodo, MessageCircle, CircleDot } from "lucide-react";

interface PipelineListProps {
  deals: Deal[];
  stages: PipelineStage[];
  taskCounts?: Record<string, DealTaskCount>;
}

// dd/MM/yyyy HH:mm — mesmo formato da barrinha do card.
function formatDateTime(dateStr: string) {
  const d = new Date(dateStr);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`;
}

function isContactTask(type: string | null, title: string | null) {
  return /lig|contat|whats|call|telefone/.test(
    `${type ?? ""} ${title ?? ""}`.toLowerCase(),
  );
}

function StatusBadge({ status }: { status: Deal["status"] }) {
  if (status === "won") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
        <Check className="h-3 w-3" />
        Ganho
      </span>
    );
  }
  if (status === "lost") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-400">
        <X className="h-3 w-3" />
        Perdido
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-400">
      <CircleDot className="h-3 w-3" />
      Em andamento
    </span>
  );
}

/**
 * Visão em LISTA do funil (toggle Kanban ⇄ Lista, estilo RD). Recebe os
 * `deals` já filtrados/ordenados pela página e os mostra numa tabela.
 * Clicar numa linha abre o detalhe do negócio (mesma navegação do card).
 */
export function PipelineList({ deals, stages, taskCounts }: PipelineListProps) {
  const stageById = useMemo(() => {
    const m = new Map<string, PipelineStage>();
    for (const s of stages) m.set(s.id, s);
    return m;
  }, [stages]);

  if (deals.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
        Nenhum negócio para os filtros atuais.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[880px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">Negócio</th>
            <th className="px-3 py-2 font-medium">Contato</th>
            <th className="px-3 py-2 font-medium">Etapa</th>
            <th className="px-3 py-2 text-right font-medium">Valor</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Responsável</th>
            <th className="px-3 py-2 font-medium">Próxima tarefa</th>
          </tr>
        </thead>
        <tbody>
          {deals.map((deal) => {
            const stage = deal.stage ?? stageById.get(deal.stage_id) ?? null;
            const tc = taskCounts?.[deal.id];
            const nextTitle = tc?.next_title ?? null;
            const nextDueAt = tc?.next_due_at ?? null;
            const nextOverdue = nextDueAt
              ? new Date(nextDueAt).getTime() < Date.now()
              : false;
            const NextIcon = isContactTask(tc?.next_type ?? null, nextTitle)
              ? MessageCircle
              : ListTodo;
            const contactLabel =
              deal.contact?.name || deal.contact?.phone || "—";
            const assigneeLabel = deal.assignee?.full_name || null;

            return (
              <tr
                key={deal.id}
                onClick={() => {
                  window.location.href = `/pipelines/${deal.id}`;
                }}
                className="cursor-pointer border-b border-border/60 transition-colors last:border-b-0 hover:bg-muted/40"
              >
                <td className="max-w-[220px] px-3 py-2">
                  <span className="block truncate font-medium text-foreground">
                    {deal.title || "Sem título"}
                  </span>
                </td>
                <td className="max-w-[180px] px-3 py-2">
                  <span className="block truncate text-muted-foreground">
                    {contactLabel}
                  </span>
                </td>
                <td className="px-3 py-2">
                  {stage ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-foreground">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: stage.color || "#64748b" }}
                      />
                      <span className="truncate">{stage.name}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-semibold text-primary">
                  {formatCurrency(deal.value, deal.currency)}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={deal.status} />
                </td>
                <td className="px-3 py-2">
                  {assigneeLabel ? (
                    <span className="inline-flex items-center gap-1.5">
                      <ContactAvatar
                        avatarUrl={deal.assignee?.avatar_url}
                        displayName={assigneeLabel}
                        className="h-5 w-5"
                      />
                      <span className="max-w-[120px] truncate text-xs text-muted-foreground">
                        {assigneeLabel}
                      </span>
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {nextTitle ? (
                    <span
                      className={`inline-flex max-w-[240px] items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ${
                        nextOverdue
                          ? "bg-red-500/15 text-red-300"
                          : "bg-muted/70 text-muted-foreground"
                      }`}
                    >
                      <NextIcon className="h-3 w-3 shrink-0" />
                      <span className="truncate">{nextTitle}</span>
                      {nextDueAt && (
                        <span className="shrink-0 tabular-nums">
                          {formatDateTime(nextDueAt)}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
