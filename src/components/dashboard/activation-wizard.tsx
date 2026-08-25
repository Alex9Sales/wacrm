'use client';

// ============================================================
// 🚀 "Ative seu Fluxia" — wizard de ativação no Painel. Lê o ESTADO REAL da
// conta (fetchActivationState): etapa já feita nasce marcada, o progresso
// nunca mente. O último passo é o Aha Moment: mandar um zap pro próprio
// número e ver a IA responder — quando a 1ª resposta chega (poll leve
// enquanto falta só ela), vira celebração "Seu agente está trabalhando".
// Some quando: dispensado, ou conta já ativada há tempo.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  MessageCircle,
  PartyPopper,
  Rocket,
  X,
} from 'lucide-react';

import {
  fetchActivationState,
  hideActivationWizard,
} from '@/app/(dashboard)/dashboard/actions';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type State = NonNullable<Awaited<ReturnType<typeof fetchActivationState>>>;

export function ActivationWizard() {
  const [state, setState] = useState<State | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const s = await fetchActivationState();
    setState(s);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Enquanto falta SÓ o Aha (4/5 e o teste pendente), poll leve pra
  // celebração aparecer ao vivo quando a IA responder.
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (!state || state.hidden || dismissed) return;
    const waitingAha = state.doneCount === state.total - 1 && !state.firstBotAt;
    if (!waitingAha) return;
    pollRef.current = setInterval(() => void load(), 12_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [state, dismissed, load]);

  const dismiss = useCallback(async () => {
    setDismissed(true);
    await hideActivationWizard();
  }, []);

  if (!loaded || !state || state.hidden || dismissed) return null;

  const complete = state.doneCount === state.total;

  // Celebração é do MOMENTO: conta cuja 1ª resposta da IA já tem mais de 48h
  // não vê nada (o wizard é pra quem ainda não chegou no valor — contas
  // veteranas não ganham banner aleatório).
  if (
    complete &&
    state.firstBotAt &&
    Date.now() - new Date(state.firstBotAt).getTime() > 48 * 3_600_000
  ) {
    return null;
  }

  // 🎉 Celebração do Aha Moment.
  if (complete) {
    return (
      <div className="relative overflow-hidden rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <PartyPopper className="h-8 w-8 shrink-0 text-emerald-500" />
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold text-foreground">
              Seu agente está trabalhando. 🎉
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              A IA respondeu a primeira conversa. Agora deixe o Fluxia
              acompanhar as próximas — e veja tudo aqui no Painel.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void dismiss()}>
            Concluir
          </Button>
        </div>
      </div>
    );
  }

  const next = state.steps.find((s) => !s.done);

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Rocket className="h-5 w-5 text-primary" />
          <div>
            <p className="text-sm font-semibold text-foreground">
              Ative seu Fluxia
            </p>
            <p className="text-xs text-muted-foreground">
              Seu Fluxia está{' '}
              <span className="font-semibold text-primary">
                {state.percent}% configurado
              </span>{' '}
              — falta pouco pra IA atender por você.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void dismiss()}
          title="Ocultar assistente"
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Barra de progresso */}
      <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-primary/15">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500"
          style={{ width: `${Math.max(state.percent, 4)}%` }}
        />
      </div>

      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {state.steps.map((s, i) => {
          const isNext = next?.key === s.key;
          const inner = (
            <>
              <span
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                  s.done
                    ? 'bg-emerald-500 text-white'
                    : isNext
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground',
                )}
              >
                {s.done ? <Check className="h-3 w-3" /> : i + 1}
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    'block truncate text-xs font-medium',
                    s.done
                      ? 'text-muted-foreground line-through'
                      : 'text-foreground',
                  )}
                >
                  {s.title}
                </span>
                {isNext && (
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                    {s.hint}
                  </span>
                )}
              </span>
              {isNext && (
                <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-primary" />
              )}
            </>
          );
          return (
            <li key={s.key}>
              {s.done ? (
                <div className="flex items-start gap-2 rounded-lg border border-transparent p-2">
                  {inner}
                </div>
              ) : (
                <a
                  href={s.href}
                  className={cn(
                    'flex items-start gap-2 rounded-lg border p-2 transition-colors',
                    isNext
                      ? 'border-primary/40 bg-background hover:bg-primary/10'
                      : 'border-transparent hover:bg-muted',
                  )}
                >
                  {inner}
                </a>
              )}
            </li>
          );
        })}
      </ol>

      {/* Passo do Aha: instrução concreta com o número conectado. */}
      {next?.key === 'first_reply' && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-background p-3">
          <MessageCircle className="h-4 w-4 shrink-0 text-primary" />
          <p className="text-xs text-muted-foreground">
            Pegue seu celular e mande uma mensagem
            {state.connectedPhone ? (
              <>
                {' '}
                para <b className="text-foreground">{state.connectedPhone}</b>
              </>
            ) : (
              ' para o número conectado'
            )}{' '}
            — veja o Fluxia atender usando as informações da sua empresa.
          </p>
        </div>
      )}
    </div>
  );
}
