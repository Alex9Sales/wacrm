'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Sparkles, CheckCircle2, Trash2, Eye, EyeOff, Check, Maximize2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPanelHead } from './settings-panel-head';
import { AiKnowledgeCard } from './ai-knowledge';
import { AI_PROVIDER_DEFAULT_MODEL } from '@/lib/ai/defaults';
import type { AiProvider } from '@/lib/ai/types';

const MASKED_KEY = '••••••••••••••••';

const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
};

const KEY_PLACEHOLDER: Record<AiProvider, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
};

export function AiConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [model, setModel] = useState(AI_PROVIDER_DEFAULT_MODEL.openai);
  const [apiKey, setApiKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [embeddingsKey, setEmbeddingsKey] = useState('');
  const [embeddingsKeyEdited, setEmbeddingsKeyEdited] = useState(false);
  const [hasStoredEmbeddingsKey, setHasStoredEmbeddingsKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [maxPerConversation, setMaxPerConversation] = useState(3);
  // Canais onde a IA responde (multi). Vazio = todos.
  const [channels, setChannels] = useState<
    { id: string; name: string; provider: string }[]
  >([]);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  // Model picker: the list of models the provider exposes for the current key.
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  // Custom combobox open state — replaces the native <datalist>, which Chrome
  // rendered unreliably (the password-manager autofill overlapped it and it
  // wouldn't list all models on a plain click).
  const [modelOpen, setModelOpen] = useState(false);

  // Guard keyed on the account (not a bare boolean) so an in-place
  // account switch — ownership transfer, multi-account membership —
  // refetches instead of showing the previous account's config. Mirrors
  // the loadedAccountIdRef pattern in whatsapp-config.tsx.
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Falha ao carregar a configuração de IA');
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setProvider(data.provider);
        setModel(data.model);
        setSystemPrompt(data.system_prompt ?? '');
        setIsActive(data.is_active);
        setAutoReplyEnabled(data.auto_reply_enabled);
        setChannelIds(
          Array.isArray(data.auto_reply_channel_ids)
            ? data.auto_reply_channel_ids
            : [],
        );
        setMaxPerConversation(data.auto_reply_max_per_conversation ?? 3);
        setHasStoredKey(Boolean(data.has_key));
        setApiKey(data.has_key ? MASKED_KEY : '');
        setKeyEdited(false);
        setHasStoredEmbeddingsKey(Boolean(data.has_embeddings_key));
        setEmbeddingsKey(data.has_embeddings_key ? MASKED_KEY : '');
        setEmbeddingsKeyEdited(false);
      }
    } catch {
      toast.error('Falha ao carregar a configuração de IA');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
  }, [accountId, fetchConfig]);

  // Load the account's channels for the "canais onde a IA responde" picker.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/channels');
        const data = (await res.json().catch(() => ({}))) as {
          channels?: { id: string; name: string; provider: string }[];
        };
        if (!cancelled && Array.isArray(data.channels)) {
          setChannels(data.channels);
        }
      } catch {
        /* best-effort — sem canais o picker só some */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Swap the model default when the provider changes, unless the user
  // typed a custom model.
  const handleProviderChange = (next: AiProvider) => {
    setProvider(next);
    const isDefaultModel =
      model === AI_PROVIDER_DEFAULT_MODEL.openai ||
      model === AI_PROVIDER_DEFAULT_MODEL.anthropic ||
      model.trim() === '';
    if (isDefaultModel) setModel(AI_PROVIDER_DEFAULT_MODEL[next]);
  };

  const keyPayload = () => (keyEdited ? apiKey.trim() : undefined);

  // Pull the provider's available models for the current key (freshly-typed or
  // stored). `silent` suppresses error toasts for the automatic load.
  const fetchModels = useCallback(
    async (silent = false) => {
      setLoadingModels(true);
      try {
        const res = await fetch('/api/ai/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider,
            api_key: keyEdited ? apiKey.trim() : undefined,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && Array.isArray(data.models)) {
          setModels(data.models);
          if (!silent) {
            toast.success(
              data.models.length
                ? `${data.models.length} modelos disponíveis.`
                : 'O provedor não retornou modelos.',
            );
          }
        } else if (!silent) {
          toast.error(data.error ?? 'Não foi possível listar os modelos.');
        }
      } catch {
        if (!silent) toast.error('Não foi possível acessar o provedor.');
      } finally {
        setLoadingModels(false);
      }
    },
    [provider, keyEdited, apiKey],
  );

  // Auto-load the model list once a stored key is present (first load).
  useEffect(() => {
    if (configured && hasStoredKey && models.length === 0) {
      void fetchModels(true);
    }
    // Intentionally not depending on fetchModels/models to run once on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, hasStoredKey]);

  // undefined = leave unchanged; '' typed = null (clear); text = set.
  const embeddingsKeyPayload = () =>
    embeddingsKeyEdited ? embeddingsKey.trim() || null : undefined;

  const buildBody = () => ({
    provider,
    model: model.trim(),
    api_key: keyPayload(),
    embeddings_api_key: embeddingsKeyPayload(),
    system_prompt: systemPrompt.trim() || null,
    is_active: isActive,
    auto_reply_enabled: autoReplyEnabled,
    auto_reply_channel_ids: channelIds,
    auto_reply_max_per_conversation: maxPerConversation,
  });

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: model.trim(),
          api_key: keyPayload(),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success('A chave funciona — o provedor respondeu.');
        // Key validated → refresh the model list for the picker.
        void fetchModels(true);
      } else toast.error(data.error ?? 'O provedor rejeitou a solicitação.');
    } catch {
      toast.error('Não foi possível acessar o provedor.');
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!model.trim()) {
      toast.error('Informe o nome do modelo.');
      return;
    }
    if (!configured && !keyEdited) {
      toast.error('Informe sua chave de API.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success('Assistente de IA salvo.');
        await fetchConfig();
      } else {
        toast.error(data.error ?? 'Falha ao salvar.');
      }
    } catch {
      toast.error('Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/ai/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success('Configuração de IA removida.');
        setConfigured(false);
        setHasStoredKey(false);
        setApiKey('');
        setKeyEdited(false);
        setIsActive(false);
        setAutoReplyEnabled(false);
        setSystemPrompt('');
      } else {
        const data = await res.json();
        toast.error(data.error ?? 'Falha ao remover.');
      }
    } catch {
      toast.error('Falha ao remover.');
    } finally {
      setRemoving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Carregando…
      </div>
    );
  }

  const disabled = !canEdit || saving;

  return (
    <div>
      <SettingsPanelHead
        title="Configuração do agente"
        description="Use sua própria chave OpenAI ou Anthropic. O wacrm chama o provedor diretamente com sua chave — sem taxas de IA por usuário, e seus dados continuam sendo seus. Isso alimenta as respostas geradas por IA na caixa de entrada, o bot de resposta automática e o Playground."
      />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Apenas administradores e proprietários podem alterar a configuração de IA.
        </p>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" /> Provedor e chave
            </CardTitle>
            <CardDescription>
              Sua chave é criptografada em repouso (AES-256-GCM) e nunca mais é
              exibida após ser salva.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Provedor</Label>
                <Select
                  value={provider}
                  onValueChange={(v) => handleProviderChange(v as AiProvider)}
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">{PROVIDER_LABEL.openai}</SelectItem>
                    <SelectItem value="anthropic">
                      {PROVIDER_LABEL.anthropic}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="ai-model">Modelo</Label>
                  <button
                    type="button"
                    onClick={() => void fetchModels(false)}
                    disabled={disabled || loadingModels}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
                  >
                    {loadingModels && <Loader2 className="h-3 w-3 animate-spin" />}
                    {loadingModels ? 'Carregando…' : 'Atualizar lista'}
                  </button>
                </div>
                <div className="relative">
                  <Input
                    id="ai-model"
                    value={model}
                    onChange={(e) => {
                      setModel(e.target.value);
                      setModelOpen(true);
                    }}
                    onFocus={() => setModelOpen(true)}
                    // Delay the close so a click on an option (mousedown below)
                    // still registers before blur tears the list down.
                    onBlur={() => window.setTimeout(() => setModelOpen(false), 120)}
                    placeholder={AI_PROVIDER_DEFAULT_MODEL[provider]}
                    disabled={disabled}
                    autoComplete="off"
                    role="combobox"
                    aria-expanded={modelOpen}
                    // Keep password managers (1Password / Chrome) off this field —
                    // it sits next to the API-key input, so they'd try to autofill.
                    data-1p-ignore="true"
                    data-lpignore="true"
                  />
                  {modelOpen &&
                    models.length > 0 &&
                    (() => {
                      const q = model.trim().toLowerCase();
                      // Browse-first: show the FULL list when the field is empty
                      // OR already holds one of the models (a current selection —
                      // clicking should reveal ALL 69, not just that one). Only
                      // narrow when the user typed a partial that isn't a model.
                      const isSelection =
                        q === "" || models.some((m) => m.toLowerCase() === q);
                      const matches = isSelection
                        ? models
                        : models.filter((m) => m.toLowerCase().includes(q));
                      const list = matches.length ? matches : models;
                      return (
                        <ul className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-popover py-1 shadow-md">
                          {list.map((m) => (
                            <li key={m}>
                              <button
                                type="button"
                                // mousedown (not click) so it fires before the
                                // input's blur closes the list.
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  setModel(m);
                                  setModelOpen(false);
                                }}
                                className={cn(
                                  'flex w-full items-center px-3 py-1.5 text-left text-sm hover:bg-muted',
                                  m === model
                                    ? 'text-primary'
                                    : 'text-popover-foreground',
                                )}
                              >
                                {m}
                              </button>
                            </li>
                          ))}
                        </ul>
                      );
                    })()}
                </div>
                <p className="text-xs text-muted-foreground">
                  {models.length > 0
                    ? `${models.length} modelos disponíveis — clique no campo para escolher (ou digite um).`
                    : 'Clique em "Atualizar lista" (ou "Testar chave") para carregar os modelos da sua chave.'}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-key">Chave de API</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="ai-key"
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setKeyEdited(true);
                    }}
                    onFocus={() => {
                      if (!keyEdited && hasStoredKey) {
                        setApiKey('');
                        setKeyEdited(true);
                      }
                    }}
                    placeholder={KEY_PLACEHOLDER[provider]}
                    disabled={disabled}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showKey ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={disabled || testing}
                >
                  {testing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                  )}
                  Testar chave
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-embeddings-key">
                Chave de embeddings{' '}
                <span className="font-normal text-muted-foreground">
                  (opcional — habilita a busca semântica na base de conhecimento)
                </span>
              </Label>
              <Input
                id="ai-embeddings-key"
                type="password"
                value={embeddingsKey}
                onChange={(e) => {
                  setEmbeddingsKey(e.target.value);
                  setEmbeddingsKeyEdited(true);
                }}
                onFocus={() => {
                  if (!embeddingsKeyEdited && hasStoredEmbeddingsKey) {
                    setEmbeddingsKey('');
                    setEmbeddingsKeyEdited(true);
                  }
                }}
                placeholder="sk-... (OpenAI)"
                disabled={disabled}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Uma chave OpenAI usada apenas para gerar embeddings da sua base
                de conhecimento (text-embedding-3-small)
                {provider === 'openai' ? ' — pode ser a mesma chave acima' : ''}.
                Deixe em branco para usar a busca por palavra-chave. Limpe o
                campo para desativar a busca semântica.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Comportamento</CardTitle>
            <CardDescription>
              Conte ao assistente sobre o seu negócio — produtos, tom de voz, o
              que ele pode e não pode prometer. Esse contexto alimenta tanto os
              rascunhos quanto as respostas automáticas.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="ai-prompt">Contexto do negócio e instruções</Label>
                <button
                  type="button"
                  onClick={() => setPromptExpanded(true)}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title="Expandir editor"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                  Expandir
                </button>
              </div>
              <Textarea
                id="ai-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="ex.: Somos a Acme, uma loja de equipamentos para café. Seja acolhedor e conciso. Nunca informe preços ou prazos de entrega — transfira para um humano nesses casos."
                rows={5}
                disabled={disabled}
              />
            </div>

            {/* Editor expandido do prompt (igual n8n) — mesma state, tela cheia. */}
            <Dialog open={promptExpanded} onOpenChange={setPromptExpanded}>
              <DialogContent className="flex h-[85vh] max-w-3xl flex-col">
                <DialogHeader>
                  <DialogTitle>Contexto do negócio e instruções</DialogTitle>
                </DialogHeader>
                <Textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="Escreva o prompt do seu agente com calma aqui…"
                  disabled={disabled}
                  className="min-h-0 flex-1 resize-none font-mono text-sm"
                />
                <div className="flex justify-end">
                  <Button onClick={() => setPromptExpanded(false)}>Concluir</Button>
                </div>
              </DialogContent>
            </Dialog>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Ativar assistente de IA
                </p>
                <p className="text-xs text-muted-foreground">
                  Interruptor principal. Ativa o botão “Rascunhar com IA” na
                  caixa de entrada.
                </p>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={setIsActive}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Responder automaticamente às mensagens recebidas
                </p>
                <p className="text-xs text-muted-foreground">
                  O bot responde automaticamente às novas mensagens recebidas
                  (apenas quando nenhum fluxo as trata e nenhum agente está
                  atribuído). Transfere para um humano quando não consegue
                  ajudar.
                </p>
              </div>
              <Switch
                checked={autoReplyEnabled}
                onCheckedChange={setAutoReplyEnabled}
                disabled={disabled || !isActive}
              />
            </div>

            {/* Canais onde a IA responde (multi). Vazio = todos os canais. */}
            {autoReplyEnabled && channels.length > 0 && (
              <div className="rounded-md border border-border p-3">
                <p className="text-sm font-medium text-foreground">
                  Canais onde a IA responde
                </p>
                <p className="mb-2 text-xs text-muted-foreground">
                  Marque um ou mais canais. Se não marcar nenhum, a IA responde
                  em <strong>todos</strong> os canais.
                </p>
                <div className="flex flex-wrap gap-2">
                  {channels.map((ch) => {
                    const checked = channelIds.includes(ch.id);
                    return (
                      <button
                        key={ch.id}
                        type="button"
                        disabled={disabled}
                        onClick={() =>
                          setChannelIds((prev) =>
                            prev.includes(ch.id)
                              ? prev.filter((id) => id !== ch.id)
                              : [...prev, ch.id],
                          )
                        }
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                          checked
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:bg-muted',
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border',
                            checked
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border',
                          )}
                        >
                          {checked && <Check className="h-2.5 w-2.5" />}
                        </span>
                        {ch.name || ch.provider}
                      </button>
                    );
                  })}
                </div>
                {channelIds.length === 0 && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Respondendo em <strong>todos</strong> os canais.
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="ai-max">Máximo de respostas automáticas por conversa</Label>
                <p className="text-xs text-muted-foreground">
                  Após esse número de respostas do bot em uma conversa, o bot
                  fica em silêncio.
                </p>
              </div>
              <Input
                id="ai-max"
                type="number"
                min={1}
                max={20}
                value={maxPerConversation}
                onChange={(e) =>
                  setMaxPerConversation(
                    Math.min(20, Math.max(1, Number(e.target.value) || 1)),
                  )
                }
                disabled={disabled || !autoReplyEnabled}
                className="w-20"
              />
            </div>
          </CardContent>
        </Card>

        <AiKnowledgeCard
          accountId={accountId}
          canEdit={canEdit}
          hasEmbeddingsKey={
            embeddingsKeyEdited
              ? embeddingsKey.trim().length > 0
              : hasStoredEmbeddingsKey
          }
        />

        <div className="flex items-center justify-between">
          {configured ? (
            <Button
              variant="ghost"
              onClick={handleRemove}
              disabled={!canEdit || removing}
              className="text-destructive hover:text-destructive"
            >
              {removing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Remover
            </Button>
          ) : (
            <span />
          )}

          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar
          </Button>
        </div>
      </div>
    </div>
  );
}
