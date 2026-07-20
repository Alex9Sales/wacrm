'use client';

// ============================================================
// Voice agent config per channel (IA de voz — fatia 1). Lists the account's
// WhatsApp (waha) channels; each card configures whether the AI answers calls
// on that number, when (always / only on overflow), and with which persona +
// voice. The media bridge reads these rows. GET/PUT /api/voice-agents.
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Phone, Info } from 'lucide-react';

interface VoiceAgent {
  channelId: string;
  channelName: string;
  phoneNumber: string | null;
  enabled: boolean;
  mode: 'always' | 'overflow';
  systemPrompt: string;
  voiceId: string;
  greeting: string;
}

// Default ElevenLabs voice (Keren — the pilot's voice). Operators paste any
// ElevenLabs voice id to switch.
const KEREN_ID = '33B4UnXyTNbgLmdEDh5P';

export function VoiceAgentsTab() {
  const [agents, setAgents] = useState<VoiceAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  // Account-level provider keys (never returned raw — we only know if set).
  const [elevenlabsSet, setElevenlabsSet] = useState(false);
  const [openaiSet, setOpenaiSet] = useState(false);
  const [elevenlabsKey, setElevenlabsKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [savingKeys, setSavingKeys] = useState(false);

  useEffect(() => {
    fetch('/api/voice-agents')
      .then(async (res) => {
        const d = (await res.json().catch(() => ({}))) as {
          agents?: VoiceAgent[];
          error?: string;
        };
        if (!res.ok) {
          toast.error(d.error || 'Não foi possível carregar os canais.');
          return;
        }
        setAgents(
          (d.agents ?? []).map((a) => ({
            ...a,
            voiceId: a.voiceId || KEREN_ID,
          })),
        );
      })
      .catch(() => toast.error('Não foi possível carregar os canais.'))
      .finally(() => setLoading(false));

    fetch('/api/voice-agents/credentials')
      .then(async (res) => {
        const d = (await res.json().catch(() => ({}))) as {
          elevenlabsSet?: boolean;
          openaiSet?: boolean;
        };
        setElevenlabsSet(!!d.elevenlabsSet);
        setOpenaiSet(!!d.openaiSet);
      })
      .catch(() => {});
  }, []);

  const saveKeys = async () => {
    if (!elevenlabsKey.trim() && !openaiKey.trim()) return;
    setSavingKeys(true);
    try {
      const payload: Record<string, string> = {};
      if (elevenlabsKey.trim()) payload.elevenlabsApiKey = elevenlabsKey.trim();
      if (openaiKey.trim()) payload.openaiApiKey = openaiKey.trim();
      const res = await fetch('/api/voice-agents/credentials', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        toast.error('Não foi possível salvar as chaves.');
        return;
      }
      if (payload.elevenlabsApiKey) setElevenlabsSet(true);
      if (payload.openaiApiKey) setOpenaiSet(true);
      setElevenlabsKey('');
      setOpenaiKey('');
      toast.success('Chaves salvas.');
    } catch {
      toast.error('Não foi possível salvar as chaves.');
    } finally {
      setSavingKeys(false);
    }
  };

  const patch = (channelId: string, next: Partial<VoiceAgent>) =>
    setAgents((prev) =>
      prev.map((a) => (a.channelId === channelId ? { ...a, ...next } : a)),
    );

  const save = async (a: VoiceAgent) => {
    setSavingId(a.channelId);
    try {
      const res = await fetch('/api/voice-agents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId: a.channelId,
          enabled: a.enabled,
          mode: a.mode,
          systemPrompt: a.systemPrompt,
          voiceId: a.voiceId,
          greeting: a.greeting,
        }),
      });
      if (!res.ok) {
        toast.error('Não foi possível salvar.');
        return;
      }
      toast.success(`Agente de voz de ${a.channelName} salvo.`);
    } catch {
      toast.error('Não foi possível salvar.');
    } finally {
      setSavingId(null);
    }
  };

  if (loading) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Carregando canais…
      </p>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        Nenhum canal de WhatsApp (não-oficial) para configurar voz.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <span>
          A IA de voz atende as ligações do canal com a persona e a voz
          definidas aqui. Comece desligado e ligue onde quiser testar.
        </span>
      </div>

      {/* Account-level provider keys */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground">
          Chaves de voz (da sua conta)
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          A voz usa <strong>ElevenLabs</strong> (fala) e{' '}
          <strong>OpenAI Realtime</strong> (cérebro). Cada chave é guardada
          criptografada e nunca é exibida de volta.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-foreground">
              Chave ElevenLabs {elevenlabsSet && <span className="text-emerald-500">· configurada</span>}
            </label>
            <input
              type="password"
              value={elevenlabsKey}
              onChange={(e) => setElevenlabsKey(e.target.value)}
              placeholder={elevenlabsSet ? '••••••••  (deixe em branco p/ manter)' : 'sk_...'}
              autoComplete="off"
              className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-foreground">
              Chave OpenAI (voz) {openaiSet && <span className="text-emerald-500">· configurada</span>}
            </label>
            <input
              type="password"
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              placeholder={openaiSet ? '••••••••  (deixe em branco p/ manter)' : 'sk-...'}
              autoComplete="off"
              className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={saveKeys}
            disabled={savingKeys || (!elevenlabsKey.trim() && !openaiKey.trim())}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {savingKeys && <Loader2 className="size-4 animate-spin" />}
            Salvar chaves
          </button>
        </div>
      </div>

      {agents.map((a) => {
        return (
          <div
            key={a.channelId}
            className="rounded-lg border border-border bg-card p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Phone className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {a.channelName}
                  </p>
                  {a.phoneNumber && (
                    <p className="truncate text-xs text-muted-foreground">
                      {a.phoneNumber}
                    </p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => patch(a.channelId, { enabled: !a.enabled })}
                className={`flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition ${
                  a.enabled ? 'bg-emerald-500' : 'bg-muted'
                }`}
                role="switch"
                aria-checked={a.enabled}
                title={a.enabled ? 'Ligado' : 'Desligado'}
              >
                <span
                  className={`size-5 rounded-full bg-white transition-transform ${
                    a.enabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {a.enabled && (
              <div className="mt-4 space-y-4 border-t border-border pt-4">
                <div>
                  <label className="text-xs font-medium text-foreground">
                    Quando atender
                  </label>
                  <div className="mt-1.5 flex gap-2">
                    {(
                      [
                        { v: 'overflow', label: 'Só no transbordo' },
                        { v: 'always', label: 'Sempre' },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.v}
                        type="button"
                        onClick={() => patch(a.channelId, { mode: opt.v })}
                        className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                          a.mode === opt.v
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:bg-muted'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {a.mode === 'overflow'
                      ? 'A IA atende só quando ninguém pega a ligação.'
                      : 'A IA atende todas as ligações deste canal.'}
                  </p>
                </div>

                <div>
                  <label className="text-xs font-medium text-foreground">
                    Voz — ID do ElevenLabs
                  </label>
                  <input
                    value={a.voiceId}
                    onChange={(e) =>
                      patch(a.channelId, { voiceId: e.target.value })
                    }
                    placeholder={KEREN_ID}
                    className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Pegue o ID da voz no ElevenLabs e cole aqui.{' '}
                    <button
                      type="button"
                      onClick={() => patch(a.channelId, { voiceId: KEREN_ID })}
                      className="text-primary hover:underline"
                    >
                      Usar Keren (padrão)
                    </button>
                  </p>
                </div>

                <div>
                  <label className="text-xs font-medium text-foreground">
                    Saudação (primeira fala)
                  </label>
                  <input
                    value={a.greeting}
                    onChange={(e) =>
                      patch(a.channelId, { greeting: e.target.value })
                    }
                    placeholder="Ex: Olá! Aqui é a Maria da Família do Gás, como posso ajudar?"
                    className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-foreground">
                    Persona / instruções
                  </label>
                  <textarea
                    value={a.systemPrompt}
                    onChange={(e) =>
                      patch(a.channelId, { systemPrompt: e.target.value })
                    }
                    rows={6}
                    placeholder="Quem é a IA, como fala, o que sabe (preços, regras, quando escalar pra um humano)…"
                    className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                  />
                </div>
              </div>
            )}

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => save(a)}
                disabled={savingId === a.channelId}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {savingId === a.channelId && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                Salvar
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
