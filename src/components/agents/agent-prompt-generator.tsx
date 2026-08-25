'use client';

// ============================================================
// 🪄 "Gerar com 3 perguntas" — o empresário não deveria precisar saber
// escrever prompt pra colocar um agente pra trabalhar (fricção medida no
// funil de ativação). Função + tom + regras de transferência → prompt
// estruturado instantâneo (templates, sem custo de IA), editável depois.
// ============================================================

import { useState } from 'react';
import { Sparkles } from 'lucide-react';

import {
  buildAgentPrompt,
  FUNCTION_LABELS,
  TONE_LABELS,
  type AgentFunction,
  type AgentTone,
  type HandoffRules,
} from '@/lib/ai/prompt-generator';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

const DEFAULT_HANDOFF: HandoffRules = {
  pedirHumano: true,
  reclamacao: true,
  naoSouber: true,
  negociacaoEspecial: true,
  risco: false,
};

const HANDOFF_OPTIONS: Array<{ key: keyof HandoffRules; label: string }> = [
  { key: 'pedirHumano', label: 'Cliente pedir pra falar com humano' },
  { key: 'reclamacao', label: 'Reclamação delicada' },
  { key: 'naoSouber', label: 'Não souber responder com segurança' },
  { key: 'negociacaoEspecial', label: 'Desconto/condição fora do padrão' },
  { key: 'risco', label: 'Situação de risco ou emergência' },
];

export function AgentPromptGenerator({
  hasExistingPrompt,
  agentName,
  onGenerate,
  disabled,
}: {
  /** Prompt atual não-vazio → avisa que gerar substitui o texto. */
  hasExistingPrompt: boolean;
  /** Nome do agente já digitado na tela (pré-preenche a persona). */
  agentName?: string;
  onGenerate: (prompt: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [nome, setNome] = useState(agentName ?? '');
  const [funcao, setFuncao] = useState<AgentFunction>('vendas');
  const [tone, setTone] = useState<AgentTone>('amigavel');
  const [handoff, setHandoff] = useState<HandoffRules>(DEFAULT_HANDOFF);

  const generate = () => {
    onGenerate(buildAgentPrompt({ nome, funcao, tone, handoff }));
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setNome((n) => n || agentName || '');
          setOpen(true);
        }}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
        title="Responda 3 perguntas e o Fluxia escreve as instruções"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Gerar com 3 perguntas
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Monte seu agente em 3 perguntas</DialogTitle>
            <DialogDescription>
              O Fluxia escreve as instruções por você — depois é só ajustar o
              que quiser. Preços e produtos não entram aqui: vêm do Catálogo e
              das Bases automaticamente.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="gen-nome">Nome do agente (opcional)</Label>
              <Input
                id="gen-nome"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                placeholder="ex.: Maria"
              />
            </div>

            <div className="space-y-1.5">
              <Label>1 · Qual a função deste agente?</Label>
              <div className="flex flex-wrap gap-1.5">
                {(Object.keys(FUNCTION_LABELS) as AgentFunction[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFuncao(f)}
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs transition-colors',
                      funcao === f
                        ? 'border-primary bg-primary/15 font-medium text-primary'
                        : 'border-border text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {FUNCTION_LABELS[f]}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>2 · Como ele deve falar?</Label>
              <div className="flex flex-wrap gap-1.5">
                {(Object.keys(TONE_LABELS) as AgentTone[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTone(t)}
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs transition-colors',
                      tone === t
                        ? 'border-primary bg-primary/15 font-medium text-primary'
                        : 'border-border text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {TONE_LABELS[t]}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>3 · Quando ele deve chamar uma pessoa?</Label>
              <div className="space-y-1">
                {HANDOFF_OPTIONS.map((o) => (
                  <label
                    key={o.key}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={handoff[o.key]}
                      onChange={(e) =>
                        setHandoff((h) => ({ ...h, [o.key]: e.target.checked }))
                      }
                      className="h-3.5 w-3.5 accent-[var(--primary)]"
                    />
                    <span className="text-foreground">{o.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {hasExistingPrompt && (
              <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                Gerar vai <strong>substituir</strong> as instruções atuais do
                agente.
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={generate}>
              <Sparkles className="mr-1.5 h-4 w-4" /> Gerar instruções
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
