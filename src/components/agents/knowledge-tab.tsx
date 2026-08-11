'use client';

// ============================================================
// Aba "Base de Conhecimento" dos Agentes IA. Modelo HÍBRIDO GUIADO:
//   1. Perfil da empresa (estruturado, sempre no contexto)
//   2. Documentos (livres, buscados por relevância — RAG já existente)
// Reusa o AiKnowledgeCard (mesmo backend/API de sempre).
// ============================================================

import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { CompanyProfileCard } from './company-profile-card';
import { AiKnowledgeCard } from '@/components/settings/ai-knowledge';

export function KnowledgeTab() {
  const { account, accountRole } = useAuth();
  const accountId = account?.id ?? null;
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [hasEmbeddingsKey, setHasEmbeddingsKey] = useState(false);

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

  return (
    <div className="space-y-6">
      <CompanyProfileCard canEdit={canEdit} />
      <AiKnowledgeCard
        accountId={accountId}
        canEdit={canEdit}
        hasEmbeddingsKey={hasEmbeddingsKey}
      />
    </div>
  );
}
