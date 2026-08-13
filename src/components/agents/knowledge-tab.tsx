'use client';

// ============================================================
// Aba "Base de Conhecimento" dos Agentes IA. Modelo HÍBRIDO (Fase K):
//   1. Perfil da empresa (estruturado, sempre no contexto de todos os agentes)
//   2. BASES nomeadas (várias por conta) — cada agente escolhe quais usa no
//      próprio card. Aqui a gente gerencia as bases e os documentos de cada uma.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Database, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { cn } from '@/lib/utils';
import { CompanyProfileCard } from './company-profile-card';
import { AiKnowledgeCard } from '@/components/settings/ai-knowledge';

interface Base {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
}

export function KnowledgeTab() {
  const { account, accountRole } = useAuth();
  const accountId = account?.id ?? null;
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [hasEmbeddingsKey, setHasEmbeddingsKey] = useState(false);
  const [bases, setBases] = useState<Base[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadingBases, setLoadingBases] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/config');
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setHasEmbeddingsKey(!!data?.has_embeddings_key);
      } catch {
        if (!cancelled) setHasEmbeddingsKey(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadBases = useCallback(async () => {
    setLoadingBases(true);
    try {
      const res = await fetch('/api/ai/knowledge/bases');
      const data = await res.json().catch(() => ({}));
      const list: Base[] = Array.isArray(data.bases) ? data.bases : [];
      setBases(list);
      // Mantém a seleção se ainda existir; senão vai pra primeira base.
      setSelected((prev) =>
        prev && list.some((b) => b.id === prev) ? prev : (list[0]?.id ?? null),
      );
    } catch {
      /* best-effort */
    } finally {
      setLoadingBases(false);
    }
  }, []);

  useEffect(() => {
    void loadBases();
  }, [loadBases]);

  const createBase = async () => {
    const name = window.prompt('Nome da nova base (ex.: Produtos, Objeções):');
    if (!name || !name.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/ai/knowledge/bases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.id) {
        toast.success('Base criada.');
        await loadBases();
        setSelected(data.id);
      } else toast.error(data.error ?? 'Falha ao criar a base.');
    } catch {
      toast.error('Falha ao criar a base.');
    } finally {
      setCreating(false);
    }
  };

  const renameBase = async (base: Base) => {
    const name = window.prompt('Novo nome da base:', base.name);
    if (!name || !name.trim() || name.trim() === base.name) return;
    try {
      const res = await fetch(`/api/ai/knowledge/bases/${base.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success('Base renomeada.');
        await loadBases();
      } else toast.error(data.error ?? 'Falha ao renomear.');
    } catch {
      toast.error('Falha ao renomear.');
    }
  };

  const deleteBase = async (base: Base) => {
    if (
      !window.confirm(
        `Apagar a base "${base.name}" e todos os seus ${base.documentCount} documento(s)? Esta ação não pode ser desfeita.`,
      )
    )
      return;
    try {
      const res = await fetch(`/api/ai/knowledge/bases/${base.id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success('Base apagada.');
        await loadBases();
      } else toast.error(data.error ?? 'Falha ao apagar.');
    } catch {
      toast.error('Falha ao apagar.');
    }
  };

  const selectedBase = bases.find((b) => b.id === selected) ?? null;

  return (
    <div className="space-y-6">
      <CompanyProfileCard canEdit={canEdit} />

      {/* Seletor de bases (Fase K) */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">
            Bases de conhecimento
          </h3>
          {loadingBases && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Organize o conhecimento em bases (ex.: Institucional, Produtos,
          Objeções). No card de cada agente você escolhe quais bases ele usa —
          assim um agente não se mistura com o conhecimento do outro.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {bases.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setSelected(b.id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                selected === b.id
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              {b.name}
              <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                {b.documentCount}
              </span>
            </button>
          ))}
          {canEdit && (
            <button
              type="button"
              onClick={createBase}
              disabled={creating}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-60"
            >
              {creating ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              Nova base
            </button>
          )}
        </div>

        {selectedBase && canEdit && (
          <div className="mt-3 flex items-center gap-3 border-t border-border pt-2.5 text-xs">
            <span className="text-muted-foreground">
              Editando <strong className="text-foreground">{selectedBase.name}</strong>
            </span>
            <button
              type="button"
              onClick={() => renameBase(selectedBase)}
              className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              <Pencil className="h-3 w-3" /> Renomear
            </button>
            <button
              type="button"
              onClick={() => deleteBase(selectedBase)}
              className="inline-flex items-center gap-1 text-destructive hover:text-destructive/80"
            >
              <Trash2 className="h-3 w-3" /> Apagar
            </button>
          </div>
        )}
      </div>

      <AiKnowledgeCard
        key={selected ?? 'all'}
        accountId={accountId}
        canEdit={canEdit}
        hasEmbeddingsKey={hasEmbeddingsKey}
        baseId={selected}
      />
    </div>
  );
}
