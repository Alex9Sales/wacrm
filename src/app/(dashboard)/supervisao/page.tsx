"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Users,
  MessageSquare,
  Clock,
  Inbox,
  Loader2,
  RefreshCw,
  ChevronRight,
  ShieldAlert,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { getSupervisionOverview, getAgentConversations } from "./actions";
import type {
  SupervisionOverview,
  AgentStat,
  AgentConversationRow,
} from "@/lib/supervision/types";

function fmtMin(min: number | null): string {
  if (min == null) return "—";
  if (min < 1) return "agora";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export default function SupervisaoPage() {
  const { canEditSettings, profileLoading } = useAuth();

  const [overview, setOverview] = useState<SupervisionOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<AgentStat | null>(null);
  const [convs, setConvs] = useState<AgentConversationRow[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      setOverview(await getSupervisionOverview());
    } catch {
      setOverview(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (profileLoading || !canEditSettings) return;
    void load();
    const t = setInterval(() => void load(true), 30_000);
    return () => clearInterval(t);
  }, [load, canEditSettings, profileLoading]);

  const selectAgent = useCallback(async (agent: AgentStat) => {
    setSelected(agent);
    setLoadingConvs(true);
    try {
      setConvs(await getAgentConversations(agent.id));
    } catch {
      setConvs([]);
    } finally {
      setLoadingConvs(false);
    }
  }, []);

  if (!profileLoading && !canEditSettings) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-2 text-center">
        <ShieldAlert className="h-10 w-10 text-muted-foreground/40" />
        <p className="text-sm font-medium text-foreground">Acesso restrito</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          A Supervisão é visível apenas para administradores e o proprietário
          da conta.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Supervisão
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Acompanhe a equipe ao vivo — carga de cada atendente, conversas
            aguardando resposta e tempo médio de resposta.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
          Atualizar
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !overview ? (
        <p className="text-sm text-muted-foreground">Não foi possível carregar.</p>
      ) : (
        <>
          {/* Overview cards */}
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              icon={<MessageSquare className="h-4 w-4" />}
              label="Conversas abertas"
              value={overview.totalOpen}
            />
            <StatCard
              icon={<Clock className="h-4 w-4" />}
              label="Aguardando resposta"
              value={overview.totalWaiting}
              tone={overview.totalWaiting > 0 ? "warn" : "default"}
            />
            <StatCard
              icon={<Inbox className="h-4 w-4" />}
              label="Sem atendente (fila)"
              value={overview.unassignedOpen}
              tone={overview.unassignedOpen > 0 ? "warn" : "default"}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
            {/* Agents */}
            <div className="rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <Users className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">
                  Atendentes
                </h2>
              </div>
              <div className="divide-y divide-border">
                {overview.agents.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => void selectAgent(a)}
                    className={cn(
                      "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50",
                      selected?.id === a.id && "bg-primary/5",
                    )}
                  >
                    <Avatar className="size-9 shrink-0">
                      {a.image ? <AvatarImage src={a.image} alt={a.name} /> : null}
                      <AvatarFallback className="bg-primary/10 text-sm text-primary">
                        {a.name?.charAt(0)?.toUpperCase() ?? "U"}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {a.name}
                      </p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        <span>{a.open} aberta{a.open === 1 ? "" : "s"}</span>
                        {a.waiting > 0 && (
                          <span className="font-medium text-amber-500">
                            {a.waiting} aguardando · +{fmtMin(a.maxWaitingMin)}
                          </span>
                        )}
                        <span>resp. méd.: {fmtMin(a.avgResponseMin)}</span>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                ))}
                {overview.agents.length === 0 && (
                  <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                    Nenhum atendente na equipe ainda.
                  </p>
                )}
              </div>
            </div>

            {/* Selected agent's conversations */}
            <div className="rounded-xl border border-border bg-card">
              <div className="border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold text-foreground">
                  {selected
                    ? `Conversas de ${selected.name}`
                    : "Selecione um atendente"}
                </h2>
                {selected && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Clique numa conversa para abrir e acompanhar o atendimento.
                  </p>
                )}
              </div>
              {!selected ? (
                <p className="px-4 py-10 text-center text-xs text-muted-foreground">
                  Escolha um atendente à esquerda para ver quem ele está
                  atendendo, de qual canal, e há quanto tempo.
                </p>
              ) : loadingConvs ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : convs.length === 0 ? (
                <p className="px-4 py-10 text-center text-xs text-muted-foreground">
                  Nenhuma conversa aberta atribuída a este atendente.
                </p>
              ) : (
                <div className="divide-y divide-border">
                  {convs.map((c) => (
                    <Link
                      key={c.id}
                      href={`/inbox?c=${c.id}`}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {c.contactName}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {c.channelName ?? "Canal"}
                        </p>
                      </div>
                      {c.waitingMin != null ? (
                        <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-500">
                          aguardando {fmtMin(c.waitingMin)}
                        </span>
                      ) : (
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          em dia
                        </span>
                      )}
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: "default" | "warn";
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-md",
            tone === "warn" && value > 0
              ? "bg-amber-500/15 text-amber-500"
              : "bg-primary/10 text-primary",
          )}
        >
          {icon}
        </span>
        {label}
      </div>
      <p
        className={cn(
          "mt-2 text-2xl font-bold",
          tone === "warn" && value > 0 ? "text-amber-500" : "text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  );
}
