'use client';

// ============================================================
// Fase K4 — Aprender da conversa com APROVAÇÃO. A IA analisa uma conversa e
// propõe Q&A; aqui o humano edita e aprova (vira Q&A na base) ou descarta.
// Nada entra na base sem aprovação.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { GraduationCap, Loader2, Check, X, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { listConversations } from '@/app/(dashboard)/inbox/actions';

interface Item {
  id: string;
  question: string;
  answer: string;
  conversationId: string | null;
  createdAt: string;
}
interface ConvOpt {
  id: string;
  label: string;
}

export function KnowledgeApprovals({
  canEdit,
  onApproved,
}: {
  canEdit: boolean;
  onApproved?: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [convs, setConvs] = useState<ConvOpt[]>([]);
  const [pick, setPick] = useState('');
  const [analyzing, setAnalyzing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/knowledge/approvals');
      const data = await res.json().catch(() => ({}));
      if (res.ok) setItems(Array.isArray(data.items) ? data.items : []);
    } catch {
      /* best-effort */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Carrega as conversas recentes pro picker (só quando pode editar).
  useEffect(() => {
    if (!canEdit) return;
    (async () => {
      try {
        const list = await listConversations();
        setConvs(
          list.slice(0, 20).map((c) => ({
            id: c.id,
            label: c.contact?.name || c.contact?.phone || 'Conversa',
          })),
        );
      } catch {
        /* best-effort */
      }
    })();
  }, [canEdit]);

  const analyze = async () => {
    if (!pick) return;
    setAnalyzing(true);
    try {
      const res = await fetch('/api/ai/knowledge/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: pick }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(
          data.created > 0
            ? `${data.created} sugestão(ões) para revisar.`
            : 'Nada reutilizável nessa conversa.',
        );
        await load();
      } else toast.error(data.error ?? 'Falha ao analisar.');
    } catch {
      toast.error('Falha ao analisar.');
    } finally {
      setAnalyzing(false);
    }
  };

  const act = async (
    id: string,
    action: 'approve' | 'reject',
    edited?: { question: string; answer: string },
  ) => {
    try {
      const res = await fetch('/api/ai/knowledge/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, ...edited }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setItems((prev) => prev.filter((i) => i.id !== id));
        if (action === 'approve') {
          toast.success('Adicionado à base.');
          onApproved?.();
        }
      } else toast.error(data.error ?? 'Falha.');
    } catch {
      toast.error('Falha.');
    }
  };

  if (!canEdit) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-2">
        <GraduationCap className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">
          Aprender das conversas
        </h3>
        {items.length > 0 && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            {items.length} para revisar
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        A IA lê uma conversa e sugere perguntas e respostas. Você revisa e aprova
        — <strong>nada entra na base sem você confirmar</strong>.
      </p>

      {/* Analisar uma conversa */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          className="h-9 min-w-[200px] flex-1 rounded-md border border-border bg-background px-2 text-sm text-foreground"
        >
          <option value="">Escolha uma conversa recente…</option>
          {convs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <Button size="sm" onClick={analyze} disabled={!pick || analyzing}>
          {analyzing ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-2 h-4 w-4" />
          )}
          Analisar
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center py-3 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Carregando…
        </div>
      ) : items.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">
          Sem sugestões pendentes. Analise uma conversa para gerar.
        </p>
      ) : (
        <div className="space-y-2.5">
          {items.map((item) => (
            <ApprovalRow key={item.id} item={item} onAct={act} />
          ))}
        </div>
      )}
    </div>
  );
}

function ApprovalRow({
  item,
  onAct,
}: {
  item: Item;
  onAct: (
    id: string,
    action: 'approve' | 'reject',
    edited?: { question: string; answer: string },
  ) => void;
}) {
  const [q, setQ] = useState(item.question);
  const [a, setA] = useState(item.answer);
  const [busy, setBusy] = useState(false);

  const run = async (action: 'approve' | 'reject') => {
    setBusy(true);
    await onAct(item.id, action, { question: q.trim(), answer: a.trim() });
    setBusy(false);
  };

  return (
    <div className="rounded-lg border border-border p-3">
      <label className="text-[11px] font-medium text-muted-foreground">
        Pergunta
      </label>
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="mb-2 h-8"
        disabled={busy}
      />
      <label className="text-[11px] font-medium text-muted-foreground">
        Resposta
      </label>
      <Textarea
        value={a}
        onChange={(e) => setA(e.target.value)}
        rows={2}
        className="mb-2"
        disabled={busy}
      />
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => run('reject')}
          disabled={busy}
          className="text-muted-foreground"
        >
          <X className="mr-1.5 h-4 w-4" /> Descartar
        </Button>
        <Button
          size="sm"
          onClick={() => run('approve')}
          disabled={busy || !q.trim() || !a.trim()}
        >
          {busy ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Check className="mr-1.5 h-4 w-4" />
          )}
          Aprovar
        </Button>
      </div>
    </div>
  );
}
