'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ACTION_CATALOG, ORCH_ACTIONS } from '@/lib/orchestration/policy';
import { Loader2, Sparkles, CheckCircle2, Trash2, Eye, EyeOff, Check, Maximize2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { canEditSettings } from '@/lib/auth/roles';
import { AgentPromptGenerator } from '@/components/agents/agent-prompt-generator';
import { AgentExternalTools } from '@/components/agents/agent-external-tools';
import { AgentMaterials } from '@/components/agents/agent-materials';
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
import { AI_PROVIDER_DEFAULT_MODEL } from '@/lib/ai/defaults';
import { AGENT_TOOLS } from '@/lib/ai/tools';
import { listPipelines } from '@/app/(dashboard)/pipelines/actions';
import {
  getAutonomyPaused,
  setAutonomyPaused as saveAutonomyPaused,
} from '@/components/settings/actions';
import type { AiProvider } from '@/lib/ai/types';

const MASKED_KEY = '••••••••••••••••';

const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google Gemini',
};

/** Rótulo do provedor tolerante a string (credencial pode ter 'gemini'). */
function providerLabel(p: string): string {
  return (PROVIDER_LABEL as Record<string, string>)[p] ?? p;
}

const KEY_PLACEHOLDER: Record<AiProvider, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
  gemini: 'AIza...',
};

export function AiConfig({
  agentId,
  onChanged,
}: {
  /** Multi-agente: quando presente, edita ESTE agente (via ?agent=<id>).
   *  Ausente = o agente default da conta (compat). */
  agentId?: string;
  /** Chamado após salvar/remover, para o painel recarregar os cards. */
  onChanged?: () => void;
} = {}) {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  // URL da config: escopada por agente quando há agentId.
  const cfgUrl = agentId
    ? `/api/ai/config?agent=${encodeURIComponent(agentId)}`
    : '/api/ai/config';

  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
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
  // Chaves de API reutilizáveis (Fase 2). credentialId '' = chave avulsa
  // (digitada abaixo, caminho legado); um id = usa aquela credencial.
  const [credentials, setCredentials] = useState<
    { id: string; provider: string; label: string; keyHint: string }[]
  >([]);
  const [credentialId, setCredentialId] = useState('');
  const [embeddingsKey, setEmbeddingsKey] = useState('');
  const [embeddingsKeyEdited, setEmbeddingsKeyEdited] = useState(false);
  const [hasStoredEmbeddingsKey, setHasStoredEmbeddingsKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [maxPerConversation, setMaxPerConversation] = useState(3);
  const [hoursMode, setHoursMode] = useState<'always' | 'inside' | 'outside'>(
    'always',
  );
  const [bufferSeconds, setBufferSeconds] = useState(8);
  const [bargeInMinutes, setBargeInMinutes] = useState(5);
  const [audioReplies, setAudioReplies] = useState(true);
  const [voiceId, setVoiceId] = useState("");
  // 🎛️ Autonomia governada (Fase 8): política da reativação proativa.
  const [reactivationLevel, setReactivationLevel] = useState<
    "suggest" | "approve" | "auto"
  >("suggest");
  // 🤖 Travas do modo Automático: teto de envios por 24h + linha de WhatsApp
  // pra abrir conversa com quem é importado (sem conversa ainda).
  const [reactivationCap, setReactivationCap] = useState(20);
  const [reactivationChannel, setReactivationChannel] = useState("");
  // 📅 Data de início do auto (YYYY-MM-DD). '' = começa já.
  const [reactivationStart, setReactivationStart] = useState("");
  // ⏰ Janela de envio (horas locais). -1 = sem janela própria (usa o horário
  // de atendimento da conta).
  const [reactivationStartHour, setReactivationStartHour] = useState(-1);
  const [reactivationEndHour, setReactivationEndHour] = useState(-1);
  // 🛑 Kill switch da conta (freio de emergência, account-level). Carrega/salva
  // separado do agente (via settings actions).
  const [autonomyPaused, setAutonomyPaused] = useState(false);
  // 🧠 Fase 2: política POR AÇÃO (Signal→Policy→Action) + travas do agente.
  const [policyActions, setPolicyActions] = useState<Record<string, "suggest" | "approve" | "auto">>({});
  const [policyPaused, setPolicyPaused] = useState(false);
  const [policyDiscountPct, setPolicyDiscountPct] = useState(5);
  const [policyHumanCooldown, setPolicyHumanCooldown] = useState(24);
  const [policyMaxPerDeal, setPolicyMaxPerDeal] = useState(1);
  const [policyMaxMsgs, setPolicyMaxMsgs] = useState(30);
  const [policyStaleCadenceId, setPolicyStaleCadenceId] = useState("");
  const [cadenceOptions, setCadenceOptions] = useState<{ id: string; name: string }[]>([]);
  const [autonomyPausedLoaded, setAutonomyPausedLoaded] = useState(false);
  // 🔒 Trava de acesso: agente só conversa com contatos da etiqueta.
  const [accessTagId, setAccessTagId] = useState("");
  const [accessDeniedMsg, setAccessDeniedMsg] = useState("");
  const [accountTags, setAccountTags] = useState<{ id: string; name: string }[]>([]);
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  // Auto-carrega as vozes quando já existe uma voz salva — assim o campo
  // mostra "Karen" em vez do voice_id cru (1 tentativa; sem chave, fica o id).
  const triedAutoVoices = useRef(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [elevenKeyInput, setElevenKeyInput] = useState("");
  const [savingElevenKey, setSavingElevenKey] = useState(false);
  const [signatureName, setSignatureName] = useState('');
  const [signatureEnabled, setSignatureEnabled] = useState(false);
  // Ferramentas do agente (Fase A): conjunto de ações ligadas (chaves de tools.ts).
  const [tools, setTools] = useState<string[]>([]);
  const toggleTool = (key: string, on: boolean) =>
    setTools((prev) =>
      on ? Array.from(new Set([...prev, key])) : prev.filter((t) => t !== key),
    );
  // Canais onde a IA responde (multi). Vazio = todos.
  const [channels, setChannels] = useState<
    { id: string; name: string; provider: string }[]
  >([]);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  // Funil DESTE agente (0139): card criado pela IA nasce nele. '' = 1º da conta.
  const [pipes, setPipes] = useState<{ id: string; name: string }[]>([]);
  const [pipelineId, setPipelineId] = useState('');
  // Bases de conhecimento que ESTE agente usa (Fase K). Vazio = todas.
  const [bases, setBases] = useState<
    { id: string; name: string; documentCount: number }[]
  >([]);
  const [baseIds, setBaseIds] = useState<string[]>([]);
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
      const res = await fetch(cfgUrl);
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Falha ao carregar a configuração de IA');
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setName(data.name ?? '');
        setProvider(data.provider);
        setModel(data.model);
        setCredentialId(data.credential_id ?? '');
        setSystemPrompt(data.system_prompt ?? '');
        setIsActive(data.is_active);
        setAutoReplyEnabled(data.auto_reply_enabled);
        setChannelIds(
          Array.isArray(data.auto_reply_channel_ids)
            ? data.auto_reply_channel_ids
            : [],
        );
        setBaseIds(
          Array.isArray(data.knowledge_base_ids)
            ? data.knowledge_base_ids
            : [],
        );
        setMaxPerConversation(data.auto_reply_max_per_conversation ?? 3);
        setHoursMode(
          data.auto_reply_hours_mode === 'inside' ||
            data.auto_reply_hours_mode === 'outside'
            ? data.auto_reply_hours_mode
            : 'always',
        );
        setBufferSeconds(
          typeof data.auto_reply_buffer_seconds === 'number'
            ? data.auto_reply_buffer_seconds
            : 8,
        );
        setBargeInMinutes(
          typeof data.barge_in_minutes === 'number' ? data.barge_in_minutes : 5,
        );
        setAudioReplies(data.audio_replies_enabled !== false);
        setVoiceId(data.voice_id ?? "");
        setReactivationLevel(
          data.autonomy?.reactivation === "auto"
            ? "auto"
            : data.autonomy?.reactivation === "approve"
              ? "approve"
              : "suggest",
        );
        setReactivationCap(
          typeof data.autonomy?.reactivationDailyCap === "number"
            ? data.autonomy.reactivationDailyCap
            : 20,
        );
        setReactivationChannel(
          typeof data.autonomy?.reactivationChannelId === "string"
            ? data.autonomy.reactivationChannelId
            : "",
        );
        setReactivationStart(
          typeof data.autonomy?.reactivationStartsAt === "string"
            ? data.autonomy.reactivationStartsAt
            : "",
        );
        setAccessTagId(
          typeof data.access?.tagId === "string" ? data.access.tagId : "",
        );
        setAccessDeniedMsg(
          typeof data.access?.deniedMessage === "string"
            ? data.access.deniedMessage
            : "",
        );
        setAccessTagId(
          typeof data.access?.tagId === "string" ? data.access.tagId : "",
        );
        setAccessDeniedMsg(
          typeof data.access?.deniedMessage === "string"
            ? data.access.deniedMessage
            : "",
        );
        setReactivationStartHour(
          typeof data.autonomy?.reactivationStartHour === "number"
            ? data.autonomy.reactivationStartHour
            : -1,
        );
        {
          const a = (data.autonomy ?? {}) as Record<string, unknown>;
          const acts = (a.actions && typeof a.actions === "object" ? a.actions : {}) as Record<string, unknown>;
          const clean: Record<string, "suggest" | "approve" | "auto"> = {};
          for (const [k, v] of Object.entries(acts)) {
            if (v === "suggest" || v === "approve" || v === "auto") clean[k] = v;
          }
          setPolicyActions(clean);
          setPolicyPaused(a.paused === true);
          setPolicyDiscountPct(typeof a.discountAutoMaxPct === "number" ? a.discountAutoMaxPct : 5);
          setPolicyHumanCooldown(typeof a.humanCooldownHours === "number" ? a.humanCooldownHours : 24);
          setPolicyMaxPerDeal(typeof a.maxAutoPerDealPerDay === "number" ? a.maxAutoPerDealPerDay : 1);
          setPolicyMaxMsgs(typeof a.maxAutoMessagesPerDay === "number" ? a.maxAutoMessagesPerDay : 30);
          setPolicyStaleCadenceId(typeof a.staleCadenceId === "string" ? a.staleCadenceId : "");
        }
        setReactivationEndHour(
          typeof data.autonomy?.reactivationEndHour === "number"
            ? data.autonomy.reactivationEndHour
            : -1,
        );
        setPipelineId(
          typeof data.pipeline_id === 'string' ? data.pipeline_id : '',
        );
        setSignatureName(data.signature_name ?? '');
        setSignatureEnabled(Boolean(data.signature_enabled));
        setTools(Array.isArray(data.tools) ? data.tools : []);
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
  }, [cfgUrl]);

  // Cadências ativas da conta (seletor "cadência para negócio parado").
  useEffect(() => {
    let alive = true;
    import("@/app/(dashboard)/automations/cadencias/actions")
      .then((m) => m.listCadences())
      .then((rows) => {
        if (!alive) return;
        setCadenceOptions(
          rows
            .filter((r) => r.active !== false)
            .map((r) => ({ id: r.id, name: r.name })),
        );
      })
      .catch(() => {
        /* sem cadências → o seletor fica só com "follow-up avulso" */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    // Guard keyed on account+agent so trocar de agente (mesma conta) refaz o load.
    const key = `${accountId ?? ''}:${agentId ?? ''}`;
    if (!accountId || loadedAccountIdRef.current === key) return;
    loadedAccountIdRef.current = key;
    void fetchConfig();
  }, [accountId, agentId, fetchConfig]);

  // 🔊 Auto-carrega as vozes do ElevenLabs quando já há uma voz salva, pra
  // exibir o NOME (ex.: Karen) em vez do voice_id cru (bug reportado 31/08).
  useEffect(() => {
    if (!voiceId || voices.length > 0 || triedAutoVoices.current) return;
    triedAutoVoices.current = true;
    void fetchVoices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceId]);

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
      // Funis da conta pro seletor "Funil deste agente".
      try {
        const list = await listPipelines();
        if (!cancelled && Array.isArray(list)) {
          setPipes(list.map((p) => ({ id: p.id, name: p.name })));
        }
      } catch {
        /* best-effort — sem funis o seletor só some */
      }
      // Etiquetas da conta pro seletor da trava de acesso.
      try {
        const { listTags } = await import("@/components/settings/actions");
        const ts = await listTags();
        if (!cancelled && Array.isArray(ts)) {
          setAccountTags(ts.map((t) => ({ id: t.id, name: t.name })));
        }
      } catch {
        /* best-effort */
      }
      // 🛑 Estado do kill switch da conta (freio de emergência da autonomia).
      try {
        const paused = await getAutonomyPaused();
        if (!cancelled) {
          setAutonomyPaused(paused);
          setAutonomyPausedLoaded(true);
        }
      } catch {
        if (!cancelled) setAutonomyPausedLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load as credenciais (Chaves de API) para o seletor.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/credentials');
        const data = (await res.json().catch(() => ({}))) as {
          credentials?: {
            id: string;
            provider: string;
            label: string;
            keyHint: string;
          }[];
        };
        if (!cancelled && Array.isArray(data.credentials)) {
          setCredentials(data.credentials);
        }
      } catch {
        /* best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load as bases de conhecimento da conta (seletor "quais bases este agente usa").
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/knowledge/bases');
        const data = (await res.json().catch(() => ({}))) as {
          bases?: { id: string; name: string; documentCount: number }[];
        };
        if (!cancelled && Array.isArray(data.bases)) setBases(data.bases);
      } catch {
        /* best-effort — sem bases o seletor só some */
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

  // Trocar a credencial: o provedor passa a vir dela (e o modelo padrão junto).
  // '' = voltar pra chave avulsa (o form mostra provider + chave de novo).
  const handleCredentialChange = (id: string) => {
    setCredentialId(id);
    setModels([]);
    if (id) {
      const c = credentials.find((x) => x.id === id);
      if (
        c &&
        (c.provider === 'openai' ||
          c.provider === 'anthropic' ||
          c.provider === 'gemini')
      ) {
        handleProviderChange(c.provider);
      }
    }
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
            // Com credencial escolhida, o servidor usa a chave dela; senão a
            // chave avulsa recém-digitada (ou a embutida).
            credential_id: credentialId || undefined,
            api_key: credentialId ? undefined : keyEdited ? apiKey.trim() : undefined,
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
    [provider, keyEdited, apiKey, credentialId],
  );

  // Auto-load the model list once a stored key OR a credential is present.
  useEffect(() => {
    if (configured && (hasStoredKey || credentialId) && models.length === 0) {
      void fetchModels(true);
    }
    // Intentionally not depending on fetchModels/models to run once on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, hasStoredKey, credentialId]);

  // undefined = leave unchanged; '' typed = null (clear); text = set.
  const embeddingsKeyPayload = () =>
    embeddingsKeyEdited ? embeddingsKey.trim() || null : undefined;

  const buildBody = () => ({
    name: name.trim() || null,
    provider,
    model: model.trim(),
    // Credencial escolhida (Fase 2) — null = chave avulsa (legado).
    credential_id: credentialId || null,
    // Com credencial, a chave vem dela; não manda a avulsa.
    api_key: credentialId ? undefined : keyPayload(),
    embeddings_api_key: embeddingsKeyPayload(),
    system_prompt: systemPrompt.trim() || null,
    is_active: isActive,
    auto_reply_enabled: autoReplyEnabled,
    auto_reply_channel_ids: channelIds,
    knowledge_base_ids: baseIds,
    auto_reply_max_per_conversation: maxPerConversation,
    auto_reply_hours_mode: hoursMode,
    auto_reply_buffer_seconds: bufferSeconds,
    barge_in_minutes: bargeInMinutes,
    audio_replies_enabled: audioReplies,
    voice_id: voiceId || null,
    autonomy: {
      reactivation: reactivationLevel,
      // Fase 2: política por ação (a reativação segue o seletor acima).
      actions: { ...policyActions, reactivation: reactivationLevel },
      paused: policyPaused,
      discountAutoMaxPct: policyDiscountPct,
      humanCooldownHours: policyHumanCooldown,
      maxAutoPerDealPerDay: policyMaxPerDeal,
      maxAutoMessagesPerDay: policyMaxMsgs,
      ...(policyStaleCadenceId ? { staleCadenceId: policyStaleCadenceId } : {}),
      // Travas só fazem sentido (e só vão pro banco) no modo automático.
      ...(reactivationLevel === "auto"
        ? {
            reactivationDailyCap: reactivationCap,
            ...(reactivationChannel
              ? { reactivationChannelId: reactivationChannel }
              : {}),
            ...(reactivationStart
              ? { reactivationStartsAt: reactivationStart }
              : {}),
            ...(reactivationStartHour >= 0 &&
            reactivationEndHour > reactivationStartHour
              ? {
                  reactivationStartHour,
                  reactivationEndHour,
                }
              : {}),
          }
        : {}),
    },
    pipeline_id: pipelineId || null,
    access: {
      tag_id: accessTagId || "",
      denied_message: accessDeniedMsg,
    },
    tools,
    signature_name: signatureName.trim() || null,
    signature_enabled: signatureEnabled && signatureName.trim().length > 0,
  });

  const fetchVoices = async () => {
    setLoadingVoices(true);
    setVoicesError(null);
    try {
      const res = await fetch('/api/ai/voices');
      const data = await res.json().catch(() => ({}));
      if (Array.isArray(data.voices) && data.voices.length > 0) {
        setVoices(data.voices);
      } else {
        setVoices([]);
        setVoicesError(data.error || 'Nenhuma voz encontrada.');
      }
    } catch {
      setVoicesError('Falha ao carregar as vozes.');
    } finally {
      setLoadingVoices(false);
    }
  };

  const saveElevenKey = async () => {
    if (!elevenKeyInput.trim()) return;
    setSavingElevenKey(true);
    setVoicesError(null);
    try {
      const res = await fetch("/api/ai/voice-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ elevenlabsApiKey: elevenKeyInput.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setVoices(Array.isArray(data.voices) ? data.voices : []);
        setElevenKeyInput("");
        toast.success("Chave ElevenLabs salva 🎙️");
      } else {
        setVoicesError(data.error || "Falha ao salvar a chave.");
      }
    } catch {
      setVoicesError("Falha ao salvar a chave.");
    } finally {
      setSavingElevenKey(false);
    }
  };

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
    // Precisa de uma chave: ou uma credencial escolhida, ou (config nova) a
    // chave avulsa digitada.
    if (!credentialId && !configured && !keyEdited) {
      toast.error('Escolha uma chave de API (ou digite uma chave avulsa).');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(cfgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success('Assistente de IA salvo.');
        await fetchConfig();
        onChanged?.();
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
      const res = await fetch(cfgUrl, { method: 'DELETE' });
      if (res.ok) {
        toast.success(agentId ? 'Agente removido.' : 'Configuração de IA removida.');
        setConfigured(false);
        setHasStoredKey(false);
        setApiKey('');
        setKeyEdited(false);
        setIsActive(false);
        setAutoReplyEnabled(false);
        setSystemPrompt('');
        onChanged?.();
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
        {agentId && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Identidade do agente</CardTitle>
              <CardDescription>
                O nome que aparece no painel. O papel dele (SDR, Follow-up,
                Vendas…) você define em “Contexto do negócio e instruções”, mais
                abaixo.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Label>Nome do agente</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="ex.: SDR, Follow-up, Vendas"
                  disabled={disabled}
                  className="max-w-xs"
                />
              </div>
            </CardContent>
          </Card>
        )}

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
            {/* Chave de API (Fase 2): escolhe uma credencial cadastrada ou
                "chave avulsa" (digita abaixo, só pra este agente). */}
            <div className="space-y-2">
              <Label>Chave de API</Label>
              <select
                value={credentialId}
                onChange={(e) => handleCredentialChange(e.target.value)}
                disabled={disabled}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                {credentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {providerLabel(c.provider) + ' · ' + c.label + ' (' + c.keyHint + ')'}
                  </option>
                ))}
                <option value="">Chave avulsa (digitar abaixo)</option>
              </select>
              <p className="text-xs text-muted-foreground">
                {credentials.length === 0 ? (
                  <>
                    Cadastre suas chaves em <strong>Chaves de API</strong> (botão
                    no topo) para reutilizar entre agentes — ou digite uma chave
                    avulsa abaixo.
                  </>
                ) : (
                  <>Escolha uma chave cadastrada ou use uma chave avulsa.</>
                )}
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Provedor</Label>
                {credentialId ? (
                  <div className="flex h-9 items-center rounded-lg border border-border bg-muted/40 px-2.5 text-sm text-muted-foreground">
                    {providerLabel(provider) + ' · da credencial'}
                  </div>
                ) : (
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
                      <SelectItem value="gemini">
                        {PROVIDER_LABEL.gemini}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
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

            {!credentialId && (
            <div className="space-y-2">
              <Label htmlFor="ai-key">Chave avulsa</Label>
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
            )}

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
              Aqui você define o <strong>papel</strong> e as{' '}
              <strong>regras</strong> do agente — quem ele é e como agir. Os{' '}
              <strong>fatos</strong> do negócio (o que vende, preços, horário)
              ficam no <strong>Perfil da empresa</strong>, no{' '}
              <strong>Catálogo</strong> e nas <strong>Bases de Conhecimento</strong>{' '}
              — e entram sozinhos no contexto.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="ai-prompt">Papel e instruções do agente</Label>
                <div className="flex items-center gap-1">
                  <AgentPromptGenerator
                    hasExistingPrompt={systemPrompt.trim().length > 0}
                    agentName={name}
                    disabled={disabled}
                    onGenerate={setSystemPrompt}
                  />
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
              </div>
              <Textarea
                id="ai-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="ex.: Você é a SDR da Fluxia. Seja breve e educada, uma pergunta por vez. Qualifique o lead e ofereça agendar uma demo. Quando não souber um dado, ofereça verificar em vez de inventar."
                rows={5}
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground">
                Diga <strong>quem</strong> ele é e <strong>como</strong> deve
                agir. Não precisa listar produtos e preços aqui — isso vem do
                Catálogo e das Bases automaticamente.
              </p>
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

            {/* Ferramentas do agente (Fase A) — o que a IA pode FAZER no CRM. */}
            <div className="rounded-md border border-border p-3">
              <p className="text-sm font-medium text-foreground">
                Ferramentas do agente
              </p>
              <p className="mb-2 text-xs text-muted-foreground">
                O que a IA pode <strong>fazer</strong> no CRM durante a conversa —
                além de responder. Ligue só o que quiser que ela faça sozinha.
              </p>
              <div className="space-y-1.5">
                {AGENT_TOOLS.map((t) => {
                  const on = tools.includes(t.key);
                  return (
                    <div
                      key={t.key}
                      className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-2.5 py-2"
                    >
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                          {t.label}
                          <span className="rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                            {t.group}
                          </span>
                          {!t.implemented && (
                            <span className="rounded bg-amber-500/10 px-1 py-0.5 text-[9px] text-amber-500">
                              em breve
                            </span>
                          )}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {t.description}
                        </p>
                      </div>
                      <Switch
                        checked={on && t.implemented}
                        onCheckedChange={(v) => toggleTool(t.key, v)}
                        disabled={disabled || !isActive || !t.implemented}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 📎 Materiais que a IA pode enviar ([[ENVIAR:nome]]) — 01/09. */}
            <AgentMaterials agentId={agentId ?? null} disabled={disabled || !isActive} />

            {/* Funil DESTE agente (0139): card criado pela IA nasce nele. */}
            {pipes.length > 0 && (
              <div className="rounded-md border border-border p-3">
                <p className="text-sm font-medium text-foreground">
                  Funil deste agente
                </p>
                <p className="mb-2 text-xs text-muted-foreground">
                  Quando este agente criar um negócio (card), ele nasce na 1ª
                  etapa deste funil. Assim cada agente trabalha o funil dele —
                  vendas, cobrança, reunião, suporte.
                </p>
                <Select
                  value={pipelineId || 'default'}
                  onValueChange={(v) =>
                    setPipelineId(!v || v === 'default' ? '' : v)
                  }
                  disabled={disabled}
                >
                  <SelectTrigger className="h-9 w-full sm:w-80">
                    <SelectValue placeholder="1º funil da conta (padrão)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">
                      1º funil da conta (padrão)
                    </SelectItem>
                    {/* Funil salvo que não veio na lista (ex.: excluído):
                        rótulo legível em vez do id cru no trigger. */}
                    {pipelineId && !pipes.some((p) => p.id === pipelineId) && (
                      <SelectItem value={pipelineId}>
                        Funil salvo (fora da lista — confira em Funis)
                      </SelectItem>
                    )}
                    {pipes.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

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

            {/* 🔧 Ferramentas externas (Fase T1) — ERP/estoque/pedidos sem n8n. */}
            {agentId && <AgentExternalTools agentId={agentId} />}

            {/* Bases de conhecimento deste agente (Fase K). Vazio = todas. */}
            {bases.length > 0 && (
              <div className="rounded-md border border-border p-3">
                <p className="text-sm font-medium text-foreground">
                  Base de Conhecimento deste agente
                </p>
                <p className="mb-2 text-xs text-muted-foreground">
                  Escolha quais bases este agente consulta ao responder. Se não
                  marcar nenhuma, ele usa <strong>todas</strong> as bases da
                  conta.
                </p>
                <div className="flex flex-wrap gap-2">
                  {bases.map((b) => {
                    const checked = baseIds.includes(b.id);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        disabled={disabled}
                        onClick={() =>
                          setBaseIds((prev) =>
                            prev.includes(b.id)
                              ? prev.filter((id) => id !== b.id)
                              : [...prev, b.id],
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
                        {b.name}
                        <span className="text-[10px] opacity-70">
                          {b.documentCount}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {baseIds.length === 0 && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Usando <strong>todas</strong> as bases da conta.
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

            {/* Buffer — junta a rajada de mensagens do cliente nesse tempo
                antes de responder (fica humano). 0 = responde na hora. */}
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="ai-buffer">Espera antes de responder (s)</Label>
                <p className="text-xs text-muted-foreground">
                  Junta as mensagens que o cliente manda em sequência e responde
                  uma vez só. 0 = na hora.
                </p>
              </div>
              <Input
                id="ai-buffer"
                type="number"
                min={0}
                max={300}
                value={bufferSeconds}
                onChange={(e) =>
                  setBufferSeconds(
                    Math.min(300, Math.max(0, Number(e.target.value) || 0)),
                  )
                }
                disabled={disabled || !autoReplyEnabled}
                className="w-20"
              />
            </div>

            {/* 🔊 Responder por áudio — master do TTS: OFF = entende áudio
                normalmente, mas responde SÓ em texto (e a preferência de áudio
                da conversa fica inerte). */}
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="ai-audio-replies">Responder por áudio (voz)</Label>
                <p className="text-xs text-muted-foreground">
                  A IA pode mandar nota de voz quando fizer sentido. Desligado:
                  ela continua entendendo áudio, imagem e documento — mas
                  responde só em texto.
                </p>
              </div>
              <Switch
                id="ai-audio-replies"
                checked={audioReplies}
                onCheckedChange={setAudioReplies}
                disabled={disabled || !autoReplyEnabled}
              />
            </div>

            {/* 🗣️ Voz do áudio (ElevenLabs). Vazio = OpenAI 'nova' (padrão). */}
            {audioReplies && (
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <Label className="text-sm">Voz do áudio (ElevenLabs)</Label>
                <p className="mb-2 mt-0.5 text-xs text-muted-foreground">
                  Vazio = voz padrão da OpenAI. Pra uma voz brasileira de
                  verdade, configure a chave do ElevenLabs em{" "}
                  <strong>Agentes de voz</strong> e escolha a voz aqui.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {voices.length > 0 ? (
                    <select
                      value={voiceId}
                      onChange={(e) => setVoiceId(e.target.value)}
                      disabled={disabled}
                      className="h-9 min-w-[200px] flex-1 rounded-md border border-border bg-background px-2 text-sm"
                    >
                      <option value="">Voz padrão (OpenAI)</option>
                      {voices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      value={voiceId}
                      onChange={(e) => setVoiceId(e.target.value)}
                      disabled={disabled}
                      placeholder="voice_id do ElevenLabs (ou carregue as vozes)"
                      className="min-w-[200px] flex-1"
                    />
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void fetchVoices()}
                    disabled={disabled || loadingVoices}
                  >
                    {loadingVoices ? "Carregando…" : "Carregar vozes"}
                  </Button>
                </div>
                {voices.length === 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input
                      type="password"
                      value={elevenKeyInput}
                      onChange={(e) => setElevenKeyInput(e.target.value)}
                      disabled={disabled || savingElevenKey}
                      placeholder="Cole aqui sua chave do ElevenLabs (sk_…)"
                      className="min-w-[200px] flex-1"
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void saveElevenKey()}
                      disabled={disabled || savingElevenKey || !elevenKeyInput.trim()}
                    >
                      {savingElevenKey ? "Salvando…" : "Salvar chave"}
                    </Button>
                  </div>
                )}
                {voicesError && (
                  <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-500">
                    {voicesError}
                  </p>
                )}
              </div>
            )}

            {/* 🤫 Barge-in — um humano respondeu (CRM ou celular)? A IA fica
                em observação por N minutos, sem precisar desligar o botão. */}
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="ai-barge-in">
                  Silêncio quando um humano responder (min)
                </Label>
                <p className="text-xs text-muted-foreground">
                  Se alguém da equipe responder (pelo CRM ou pelo celular), a IA
                  fica só observando por esse tempo — e depois volta sem
                  atropelar o que o humano já resolveu. 0 = desligado.
                </p>
              </div>
              <Input
                id="ai-barge-in"
                type="number"
                min={0}
                max={120}
                value={bargeInMinutes}
                onChange={(e) =>
                  setBargeInMinutes(
                    Math.min(120, Math.max(0, Number(e.target.value) || 0)),
                  )
                }
                disabled={disabled || !autoReplyEnabled}
                className="w-20"
              />
            </div>

            {/* 🔒 Trava de acesso: agente exclusivo pra clientes (etiqueta). */}
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <Label className="text-sm">
                🔒 Atender somente clientes (trava de acesso)
              </Label>
              <p className="mb-2 mt-0.5 text-xs text-muted-foreground">
                O agente só conversa com contatos que têm a etiqueta escolhida
                (ex.: “Aluno”, “Assinante”). Quem não tem recebe a mensagem
                abaixo uma única vez — e a IA fica em silêncio. Perfeito pra
                agente de suporte exclusivo.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={accessTagId || "off"}
                  onValueChange={(v) =>
                    setAccessTagId(!v || v === "off" ? "" : v)
                  }
                  disabled={disabled}
                >
                  <SelectTrigger className="h-9 w-full sm:w-72">
                    <SelectValue placeholder="Sem trava (atende todos)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Sem trava (atende todos)</SelectItem>
                    {accessTagId &&
                      !accountTags.some((t) => t.id === accessTagId) && (
                        <SelectItem value={accessTagId}>
                          Etiqueta salva (fora da lista)
                        </SelectItem>
                      )}
                    {accountTags.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {accessTagId && (
                <textarea
                  value={accessDeniedMsg}
                  onChange={(e) => setAccessDeniedMsg(e.target.value)}
                  disabled={disabled}
                  rows={2}
                  maxLength={500}
                  placeholder="Mensagem pra quem não é cliente (padrão: “Este canal é exclusivo para clientes…”)"
                  className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                />
              )}
            </div>

            {/* 🧠 Fase 2 — política POR AÇÃO: o que a IA pode fazer sozinha, o que
                pede aprovação (fila "Precisa de você") e o que só sugere no card. */}
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <Label className="text-sm">Autonomia por ação</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Sinais (proposta parada, follow-up vencido, negócio esfriando, cliente quente, risco de churn…)
                    viram ações. Aqui você diz, ação por ação, até onde a IA vai. Fechar negócio, enviar proposta e
                    desconto sempre passam por um humano.
                  </p>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch checked={policyPaused} onCheckedChange={(v) => setPolicyPaused(!!v)} disabled={disabled} />
                  Pausar a autonomia deste agente
                </label>
              </div>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-1 pr-2 font-medium">Ação</th>
                      <th className="py-1 pr-2 font-medium">Só sugere</th>
                      <th className="py-1 pr-2 font-medium">Pede aprovação</th>
                      <th className="py-1 font-medium">Automático</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ORCH_ACTIONS.filter((a) => a !== "reactivation").map((act) => {
                      const meta = ACTION_CATALOG[act];
                      const current = policyActions[act] ?? meta.defaultLevel;
                      const set = (lvl: "suggest" | "approve" | "auto") =>
                        setPolicyActions((p) => ({ ...p, [act]: lvl }));
                      const cell = (lvl: "suggest" | "approve" | "auto", blocked?: boolean) => (
                        <td key={lvl} className="py-1.5 pr-2">
                          <button
                            type="button"
                            disabled={disabled || blocked}
                            onClick={() => set(lvl)}
                            aria-pressed={current === lvl}
                            className={`h-6 w-6 rounded-full border transition-colors disabled:opacity-30 ${
                              current === lvl
                                ? lvl === "auto"
                                  ? "border-amber-500 bg-amber-500"
                                  : "border-primary bg-primary"
                                : "border-border bg-background hover:bg-muted"
                            }`}
                          />
                        </td>
                      );
                      return (
                        <tr key={act} className="border-t border-border/60">
                          <td className="py-1.5 pr-2">
                            <div className="font-medium text-foreground">{meta.label}</div>
                            <div className="text-[11px] text-muted-foreground">
                              {meta.hint}
                              {meta.humanOnly ? " · só humano executa" : meta.risk === "critical" ? " · crítico" : ""}
                            </div>
                          </td>
                          {cell("suggest")}
                          {cell("approve")}
                          {cell("auto", !!meta.humanOnly || meta.risk === "critical")}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-4">
                <div>
                  <Label className="text-xs">Desconto automático até (%)</Label>
                  <Input type="number" min={0} max={100} value={policyDiscountPct} disabled={disabled}
                    onChange={(e) => setPolicyDiscountPct(Math.min(100, Math.max(0, Number(e.target.value) || 0)))} className="mt-1 w-24" />
                </div>
                <div>
                  <Label className="text-xs">Silêncio após humano (h)</Label>
                  <Input type="number" min={0} max={168} value={policyHumanCooldown} disabled={disabled}
                    onChange={(e) => setPolicyHumanCooldown(Math.min(168, Math.max(0, Number(e.target.value) || 0)))} className="mt-1 w-24" />
                  <p className="mt-1 text-[11px] text-muted-foreground">Se um atendente falou na conversa, a IA pede aprovação em vez de agir.</p>
                </div>
                <div>
                  <Label className="text-xs">Ações automáticas por negócio/dia</Label>
                  <Input type="number" min={1} max={10} value={policyMaxPerDeal} disabled={disabled}
                    onChange={(e) => setPolicyMaxPerDeal(Math.min(10, Math.max(1, Number(e.target.value) || 1)))} className="mt-1 w-24" />
                </div>
                <div className="sm:col-span-2">
                  <Label className="text-xs">Cadência para negócio parado</Label>
                  <Select
                    value={policyStaleCadenceId || "none"}
                    onValueChange={(v) => setPolicyStaleCadenceId(!v || v === "none" ? "" : String(v))}
                  >
                    <SelectTrigger className="mt-1" disabled={disabled}>
                      <SelectValue placeholder="Só follow-up avulso">
                        {policyStaleCadenceId
                          ? (cadenceOptions.find((c) => c.id === policyStaleCadenceId)?.name ?? "Cadência escolhida")
                          : "Só follow-up avulso"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Só follow-up avulso</SelectItem>
                      {cadenceOptions.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Escolhida, a IA sugere colocar o cliente nessa sequência em vez de mandar uma mensagem solta (quem já está numa cadência não entra em outra).
                  </p>
                </div>
                <div>
                  <Label className="text-xs">Mensagens automáticas por dia</Label>
                  <Input type="number" min={1} max={500} value={policyMaxMsgs} disabled={disabled}
                    onChange={(e) => setPolicyMaxMsgs(Math.min(500, Math.max(1, Number(e.target.value) || 1)))} className="mt-1 w-24" />
                </div>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Sempre valem, mesmo no automático: kill switch da conta, horário de atendimento, quem pediu pra não
                receber, 1 ação por negócio por dia, e nada por cima de uma conversa que um humano está tocando.
                Tudo fica registrado em <strong>Precisa de você → Auditoria</strong>.
              </p>
            </div>

            {/* 🎛️ Autonomia governada (Fase 8): reativação proativa. A IA lê o
                histórico (recompra atrasada / cliente sumido) e, conforme a
                política, sugere na lista ou rascunha pra você aprovar. */}
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <Label className="text-sm">Reativar clientes (proativo)</Label>
              <p className="mb-2 mt-0.5 text-xs text-muted-foreground">
                A IA olha o histórico e aponta quem chamar de volta. Você decide
                o quanto ela age — nada sai sem passar por você.
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                {(
                  [
                    {
                      v: "suggest" as const,
                      t: "Só sugere",
                      d: 'Aparece na lista "Chamar de volta". Você inicia.',
                    },
                    {
                      v: "approve" as const,
                      t: "Rascunha p/ aprovar",
                      d: "A IA escreve a mensagem e você aprova com 1 clique.",
                    },
                    {
                      v: "auto" as const,
                      t: "Automático",
                      d: "A IA envia sozinha — com limite diário e travas.",
                    },
                  ]
                ).map((opt) => (
                  <button
                    key={opt.v}
                    type="button"
                    onClick={() => setReactivationLevel(opt.v)}
                    disabled={disabled}
                    className={`rounded-lg border p-2.5 text-left transition-colors ${
                      reactivationLevel === opt.v
                        ? opt.v === "auto"
                          ? "border-amber-500 bg-amber-500/[0.08] ring-1 ring-amber-500"
                          : "border-primary bg-primary/[0.06] ring-1 ring-primary"
                        : "border-border hover:bg-muted"
                    }`}
                  >
                    <div className="text-sm font-medium text-foreground">
                      {opt.t}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {opt.d}
                    </div>
                  </button>
                ))}
              </div>
              {reactivationLevel === "approve" && (
                <p className="mt-2 text-xs text-primary">
                  Os rascunhos da IA aparecem em{" "}
                  <strong>Chamar de volta</strong> pra você aprovar ou recusar.
                </p>
              )}

              {/* 🤖 Modo Automático: travas + linha de envio. Só aparece quando
                  'auto' está escolhido. O kill switch é da CONTA (freio geral). */}
              {reactivationLevel === "auto" && (
                <div className="mt-3 space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/[0.05] p-3">
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    ⚠️ <strong>A IA vai enviar sozinha</strong>, sem passar por
                    você. Travas: só no horário configurado, no máximo{" "}
                    <strong>{reactivationCap}/dia</strong> — e devagar (até 3 a
                    cada meia hora, com 1–2 min entre cada envio, pra proteger a
                    linha) — 1× a cada 7 dias por cliente, respeitando quem
                    pediu pra não receber, e nunca por cima de uma conversa que
                    um humano está tocando.
                  </p>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="ai-reactivation-cap" className="text-xs">
                        Máximo de envios por dia
                      </Label>
                      <Input
                        id="ai-reactivation-cap"
                        type="number"
                        min={1}
                        max={500}
                        value={reactivationCap}
                        onChange={(e) =>
                          setReactivationCap(
                            Math.min(
                              500,
                              Math.max(1, Number(e.target.value) || 1),
                            ),
                          )
                        }
                        disabled={disabled}
                        className="mt-1 w-28"
                      />
                    </div>
                    <div>
                      <Label htmlFor="ai-reactivation-start" className="text-xs">
                        Começar a partir de
                      </Label>
                      <Input
                        id="ai-reactivation-start"
                        type="date"
                        value={reactivationStart}
                        onChange={(e) => setReactivationStart(e.target.value)}
                        disabled={disabled}
                        className="mt-1 w-44"
                      />
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Vazio = já. Antes dessa data a IA fica pronta mas não
                        envia.
                      </p>
                    </div>
                    <div className="sm:col-span-2">
                      <Label className="text-xs">
                        Horário dos envios (hora local)
                      </Label>
                      <div className="mt-1 flex items-center gap-2">
                        <Select
                          value={String(reactivationStartHour)}
                          onValueChange={(v) =>
                            setReactivationStartHour(Number(v ?? -1))
                          }
                        >
                          <SelectTrigger className="w-40" disabled={disabled}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="-1">
                              Horário de atendimento
                            </SelectItem>
                            {Array.from({ length: 24 }, (_, h) => (
                              <SelectItem key={h} value={String(h)}>
                                a partir das {h}h
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {reactivationStartHour >= 0 && (
                          <Select
                            value={String(reactivationEndHour)}
                            onValueChange={(v) =>
                              setReactivationEndHour(Number(v ?? -1))
                            }
                          >
                            <SelectTrigger className="w-32" disabled={disabled}>
                              <SelectValue placeholder="até…" />
                            </SelectTrigger>
                            <SelectContent>
                              {Array.from({ length: 24 }, (_, i) => i + 1)
                                .filter((h) => h > reactivationStartHour)
                                .map((h) => (
                                  <SelectItem key={h} value={String(h)}>
                                    até as {h}h
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Os envios saem espaçados dentro dessa janela (até 3 a
                        cada meia hora). Ex.: 9h–12h manda o dia todo entre 9h e
                        meio-dia.
                      </p>
                    </div>
                    <div>
                      <Label
                        htmlFor="ai-reactivation-channel"
                        className="text-xs"
                      >
                        Linha de WhatsApp (p/ clientes importados)
                      </Label>
                      <Select
                        value={reactivationChannel || "none"}
                        onValueChange={(v) =>
                          setReactivationChannel(v && v !== "none" ? v : "")
                        }
                      >
                        <SelectTrigger
                          id="ai-reactivation-channel"
                          className="mt-1"
                          disabled={disabled}
                        >
                          <SelectValue placeholder="Escolha a linha" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">
                            Só quem já tem conversa
                          </SelectItem>
                          {channels
                            .filter((c) =>
                              ["waha", "meta", "whatsapp"].includes(c.provider),
                            )
                            .map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Sem uma linha escolhida, a IA só reativa quem já tem uma
                    conversa aberta. Escolha uma linha pra ela também abrir o
                    papo com clientes da sua base importada.
                  </p>

                  {/* 🛑 Kill switch — freio de emergência de TODA a conta. */}
                  <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-background/60 px-3 py-2">
                    <div>
                      <Label className="text-xs font-semibold text-foreground">
                        🛑 Pausar toda a autonomia (freio de emergência)
                      </Label>
                      <p className="text-[11px] text-muted-foreground">
                        Vale pra conta inteira. Ligado, nenhuma IA envia
                        reativação automática — mesmo com o modo automático
                        ligado. Use se algo sair do controle.
                      </p>
                    </div>
                    <Switch
                      checked={autonomyPaused}
                      disabled={disabled || !autonomyPausedLoaded}
                      onCheckedChange={async (v) => {
                        setAutonomyPaused(v);
                        try {
                          await saveAutonomyPaused(v);
                        } catch {
                          setAutonomyPaused(!v); // reverte no erro
                        }
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Horário de atendimento da IA — reusa o horário da conta
                (Config → Atendimento). "Só fora" cobre empresa fechada + fim
                de semana com um clique. */}
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label>Quando a IA deve atender</Label>
                <p className="text-xs text-muted-foreground">
                  Usa o horário de atendimento da conta (Configurações →
                  Atendimento). Ex.: “Só fora do horário” = atende quando a
                  empresa está fechada e nos fins de semana.
                </p>
              </div>
              <Select
                value={hoursMode}
                onValueChange={(v) =>
                  v && setHoursMode(v as 'always' | 'inside' | 'outside')
                }
              >
                <SelectTrigger
                  className="w-48 shrink-0"
                  disabled={disabled || !autoReplyEnabled}
                >
                  <SelectValue>
                    {hoursMode === 'inside'
                      ? 'Só dentro do horário'
                      : hoursMode === 'outside'
                        ? 'Só fora do horário'
                        : 'Sempre'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">Sempre</SelectItem>
                  <SelectItem value="inside">Só dentro do horário</SelectItem>
                  <SelectItem value="outside">Só fora do horário</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Assinatura do atendente — a IA assina as mensagens com o nome
                do atendente que ela representa (padrão *Nome* do WhatsApp). */}
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Assinar mensagens com o nome do atendente
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Quando ligado, a IA assina a primeira mensagem com o nome
                    abaixo (ex.: <strong>*Danyela*</strong>), como um atendente.
                  </p>
                </div>
                <Switch
                  checked={signatureEnabled}
                  onCheckedChange={setSignatureEnabled}
                  disabled={disabled || !autoReplyEnabled}
                />
              </div>
              {signatureEnabled && (
                <div className="mt-3">
                  <Label htmlFor="ai-signature">Nome do atendente</Label>
                  <Input
                    id="ai-signature"
                    value={signatureName}
                    onChange={(e) => setSignatureName(e.target.value.slice(0, 60))}
                    placeholder="Ex.: Danyela"
                    disabled={disabled || !autoReplyEnabled}
                    className="mt-1 max-w-xs"
                  />
                  {signatureName.trim().length === 0 && (
                    <p className="mt-1 text-xs text-amber-600">
                      Informe um nome para a assinatura ficar ativa.
                    </p>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* A Base de conhecimento agora vive na aba dedicada "Base de
            Conhecimento" (Agentes IA), junto do Perfil da empresa. */}

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
