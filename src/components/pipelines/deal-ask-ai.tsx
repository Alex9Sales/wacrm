"use client";

import { useState } from "react";
import { askDealAI } from "@/app/(dashboard)/pipelines/actions";
import { Sparkles, Loader2, Send } from "lucide-react";

/**
 * IA para Negociações v2 — Fase 0: "Pergunte à IA" sobre o negócio.
 * Caixa de Q&A read-only no detalhe do negócio. Chama askDealAI (que monta o
 * contexto: campos + histórico + conversa) e mostra a resposta. Não grava nada.
 */
const SUGGESTIONS = [
  "Resumir este negócio",
  "Qual o próximo passo?",
  "Quais as objeções do cliente?",
];

export function DealAskAI({ dealId }: { dealId: string }) {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function ask(question: string) {
    const text = question.trim();
    if (!text || loading) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    const res = await askDealAI(dealId, text);
    setLoading(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setAnswer(res.answer ?? "");
  }

  return (
    <div className="space-y-2 rounded-xl border border-primary/25 bg-primary/5 p-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-primary">
        <Sparkles className="h-4 w-4" /> Pergunte à IA
      </p>

      <div className="flex flex-wrap gap-1">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setQ(s);
              void ask(s);
            }}
            disabled={loading}
            className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>

      <div className="flex items-end gap-1.5">
        <textarea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(q);
            }
          }}
          placeholder="Ex.: qual o próximo passo com esse lead?"
          rows={2}
          className="flex-1 resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary"
        />
        <button
          type="button"
          onClick={() => void ask(q)}
          disabled={loading || !q.trim()}
          aria-label="Perguntar"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </button>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      {answer && (
        <div className="whitespace-pre-wrap rounded-md border border-border bg-background p-2 text-xs text-foreground">
          {answer}
        </div>
      )}

      <p className="text-[10px] text-muted-foreground">
        Responde com base nos campos, histórico e conversa deste negócio.
      </p>
    </div>
  );
}
