'use client';

// ============================================================
// Card "IA em Negociações" — mora no painel de Agentes, SEPARADO da config de
// chat de cada agente (Alex: "tira dali pra não misturar"). Liga/desliga a IA
// proativa que analisa negócios e deixa sugestões no card do negócio.
// Backend: /api/ai/deal-proactive (flag no agente default).
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Sparkles, Loader2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';

export function DealProactiveCard({ canEdit }: { canEdit: boolean }) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/deal-proactive');
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) setEnabled(!!data.enabled);
      } catch {
        /* best-effort */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async (next: boolean) => {
    setSaving(true);
    setEnabled(next); // otimista
    try {
      const res = await fetch('/api/ai/deal-proactive', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEnabled(!next); // reverte
        toast.error(data.error ?? 'Falha ao salvar.');
      } else {
        toast.success(next ? 'IA proativa ligada.' : 'IA proativa desligada.');
      }
    } catch {
      setEnabled(!next);
      toast.error('Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Sparkles className="h-4.5 w-4.5" />
        </span>
        <div>
          <p className="text-sm font-semibold text-foreground">
            IA proativa em Negociações
          </p>
          <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
            A IA analisa sozinha cada negócio quando o cliente responde e deixa{' '}
            <strong>sugestões</strong> (campos + próximo passo, incluindo mensagem
            de follow-up para agendar) no card do negócio — você confirma o que
            quiser. Nada é gravado ou enviado sozinho. Roda em segundo plano e
            consome tokens.
          </p>
        </div>
      </div>
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <Switch
          checked={enabled}
          onCheckedChange={toggle}
          disabled={!canEdit || saving}
        />
      )}
    </div>
  );
}
