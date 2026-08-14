'use client';

// ============================================================
// Painel de controle dos Agentes IA (Fase A). Lista os agentes da conta como
// cards; clicar abre a config daquele agente. "Novo agente" cria um (herdando
// a chave do default) e já abre pra configurar. Métricas de custo/atendimento
// entram na Fase B.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Bot, Plus, Loader2, ChevronRight, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface AgentUsage {
  todayCostUsd: number;
  todayCostBrl: number;
  monthCostUsd: number;
  monthCostBrl: number;
  todayConversations: number;
  monthConversations: number;
}

interface Agent {
  id: string;
  name: string;
  isDefault: boolean;
  provider: string;
  model: string;
  isActive: boolean;
  autoReplyEnabled: boolean;
  autoReplyChannelIds: string[];
  hasKey: boolean;
  usage?: AgentUsage | null;
}

const ZERO_USAGE: AgentUsage = {
  todayCostUsd: 0,
  todayCostBrl: 0,
  monthCostUsd: 0,
  monthCostBrl: 0,
  todayConversations: 0,
  monthConversations: 0,
};

const brl = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function AgentsPanel({
  onOpen,
  onFirstSetup,
  canEdit,
}: {
  onOpen: (id: string) => void;
  onFirstSetup: () => void;
  canEdit: boolean;
}) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showCosts, setShowCosts] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/agents');
      const data = await res.json();
      if (res.ok) {
        setAgents(Array.isArray(data.agents) ? data.agents : []);
        setShowCosts(!!data.showCosts);
      } else toast.error(data.error ?? 'Falha ao carregar os agentes.');
    } catch {
      toast.error('Falha ao carregar os agentes.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createAgent = async () => {
    setCreating(true);
    try {
      const res = await fetch('/api/ai/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Novo agente' }),
      });
      const data = await res.json();
      if (res.ok && data.id) onOpen(data.id);
      else toast.error(data.error ?? 'Falha ao criar o agente.');
    } catch {
      toast.error('Falha ao criar o agente.');
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Carregando agentes…
      </div>
    );
  }

  // Conta ainda sem nenhum agente → setup do primeiro (vira o default).
  if (agents.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border py-12 text-center">
        <Bot className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        <p className="font-medium text-foreground">Nenhum agente ainda</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Crie seu primeiro agente com a sua chave (OpenAI ou Anthropic). Ele
          será o agente principal — os próximos herdam a chave dele.
        </p>
        {canEdit && (
          <Button className="mt-4" onClick={onFirstSetup}>
            <Plus className="mr-1.5 h-4 w-4" /> Configurar primeiro agente
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {agents.map((a) => {
        // Estado REAL para o cliente, honesto sobre o que a IA faz:
        // - desligado (cinza): assistente desligado.
        // - responde sozinho (verde): responde os clientes automaticamente.
        // - não responde sozinho (âmbar): ligado só para rascunhar respostas na
        //   caixa de entrada — NÃO responde ninguém sozinho. (Antes o card dizia
        //   só "ativo" aqui e parecia que o bot estava atendendo.)
        const status = !a.isActive
          ? {
              label: 'desligado',
              dot: 'bg-muted-foreground/50',
              text: 'text-muted-foreground',
              title: 'A IA está desligada para este agente.',
            }
          : a.autoReplyEnabled
            ? {
                label: 'responde sozinho',
                dot: 'bg-emerald-500',
                text: 'text-emerald-600 dark:text-emerald-400',
                title: 'A IA responde os clientes automaticamente.',
              }
            : {
                label: 'não responde sozinho',
                dot: 'bg-amber-500',
                text: 'text-amber-600 dark:text-amber-400',
                title:
                  'A IA está ligada só para rascunhar respostas na caixa de entrada — ela NÃO responde os clientes sozinha. Ligue “Responder automaticamente” na configuração para ela atender sozinha.',
              };
        return (
        <button
          key={a.id}
          type="button"
          onClick={() => onOpen(a.id)}
          className="group flex flex-col rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
        >
          <div className="mb-3 flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Bot className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-foreground">
                  {a.name}
                </span>
                {a.isDefault && (
                  <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    Principal
                  </span>
                )}
              </div>
              <span
                title={status.title}
                className={`flex items-center gap-1 text-xs ${status.text}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                {status.label}
              </span>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </div>
          {showCosts &&
            (() => {
              const u = a.usage ?? ZERO_USAGE;
              return (
                <div className="mb-2.5 grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-muted/50 px-2.5 py-1.5">
                    <div className="text-[11px] text-muted-foreground">
                      Custo no mês
                    </div>
                    <div className="text-sm font-semibold tabular-nums text-foreground">
                      {brl(u.monthCostBrl)}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      hoje {brl(u.todayCostBrl)}
                    </div>
                  </div>
                  <div className="rounded-lg bg-muted/50 px-2.5 py-1.5">
                    <div className="text-[11px] text-muted-foreground">
                      Atendimentos
                    </div>
                    <div className="text-sm font-semibold tabular-nums text-foreground">
                      {u.monthConversations}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      hoje {u.todayConversations}
                    </div>
                  </div>
                </div>
              );
            })()}
          <div className="mt-auto flex items-center gap-3 border-t border-border pt-2.5 text-xs text-muted-foreground">
            <span className="truncate">
              {a.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} · {a.model}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <Radio className="h-3.5 w-3.5" />
              {a.autoReplyChannelIds.length === 0
                ? 'todos os canais'
                : `${a.autoReplyChannelIds.length} canal(is)`}
            </span>
          </div>
        </button>
        );
      })}

      {canEdit && (
        <button
          type="button"
          onClick={createAgent}
          disabled={creating}
          className="flex min-h-[104px] items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-60"
        >
          {creating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Novo agente
        </button>
      )}
    </div>
  );
}
