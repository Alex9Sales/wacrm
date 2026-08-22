"use client";

import { useEffect, useState } from "react";
import { TrendingUp, Target, CalendarClock } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import {
  getPipelineForecast,
  type PipelineForecast,
} from "@/app/(dashboard)/pipelines/actions";

/**
 * Previsão de receita ("vou bater a meta?") no topo do funil. Lidera com o
 * FUNIL PONDERADO (soma de valor × probabilidade da etapa dos negócios abertos)
 * — sempre útil. Quando há meta (sales_goals) e datas de fechamento, mostra a
 * projeção do mês contra a meta. Busca sozinho; refaz quando `refreshKey` muda.
 */
export function PipelineForecastCard({
  pipelineId,
  refreshKey,
}: {
  pipelineId: string | null;
  refreshKey?: number;
}) {
  const { defaultCurrency } = useAuth();
  const [data, setData] = useState<PipelineForecast | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!pipelineId) {
      setData(null);
      return;
    }
    let alive = true;
    setLoading(true);
    getPipelineForecast(pipelineId)
      .then((res) => alive && setData(res))
      .catch(() => alive && setData(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [pipelineId, refreshKey]);

  if (!pipelineId || loading || !data) return null;

  const {
    goal,
    wonThisMonth,
    weightedThisMonth,
    weightedOpenTotal,
    projection,
    openNoDateCount,
  } = data;
  // Nada pra mostrar (funil vazio e sem meta) → não polui a tela.
  if (goal <= 0 && weightedOpenTotal <= 0) return null;

  const money = (v: number) => formatCurrency(v, defaultCurrency);
  const pct = goal > 0 ? Math.round((projection / goal) * 100) : 0;
  const remaining = Math.max(0, goal - projection);
  const wonPct = goal > 0 ? Math.min(100, (wonThisMonth / goal) * 100) : 0;
  const weightedPct =
    goal > 0 ? Math.min(100 - wonPct, (weightedThisMonth / goal) * 100) : 0;
  const monthCap = data.monthLabel
    ? data.monthLabel.charAt(0).toUpperCase() + data.monthLabel.slice(1)
    : "este mês";

  return (
    <div className="mb-3 rounded-xl border border-border bg-card/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <TrendingUp className="size-4 text-primary" />
          Previsão de receita
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span
            className="flex items-center gap-1 text-foreground"
            title="Soma de valor × probabilidade da etapa dos negócios abertos"
          >
            <span className="text-muted-foreground">Funil ponderado</span>
            <strong className="tabular-nums">{money(weightedOpenTotal)}</strong>
          </span>
          {goal > 0 && (
            <>
              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <span className="text-muted-foreground">Ganho ({monthCap})</span>
                <strong className="tabular-nums">{money(wonThisMonth)}</strong>
              </span>
              <span className="flex items-center gap-1 text-foreground">
                <Target className="size-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">Meta</span>
                <strong className="tabular-nums">{money(goal)}</strong>
                <span
                  className={`ml-1 rounded-full px-1.5 py-0.5 tabular-nums ${
                    pct >= 100
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {pct}%
                </span>
              </span>
            </>
          )}
        </div>
      </div>

      {goal > 0 && (
        <>
          <div className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-emerald-500"
              style={{ width: `${wonPct}%` }}
              title={`Ganho no mês: ${money(wonThisMonth)}`}
            />
            <div
              className="h-full bg-amber-400/70"
              style={{ width: `${weightedPct}%` }}
              title={`Ponderado a fechar esse mês: ${money(weightedThisMonth)}`}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {pct >= 100
              ? `🎉 Projeção do mês (${money(projection)}) já bate a meta.`
              : `Projeção do mês ${money(projection)} — faltam ${money(
                  remaining,
                )} pra meta (ganho + ${money(weightedThisMonth)} ponderado a fechar).`}
          </p>
        </>
      )}

      {openNoDateCount > 0 && (
        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
          <CalendarClock className="size-3" />
          {openNoDateCount} negócio(s) sem data de fechamento — defina a data pra
          eles entrarem na projeção do mês.
        </p>
      )}
    </div>
  );
}
