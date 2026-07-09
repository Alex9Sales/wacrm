"use client";

import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2, PenLine, AudioLines, Timer } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import {
  getAgentSignatureEnabled,
  setAgentSignatureEnabled,
  getAudioTranscriptionEnabled,
  setAudioTranscriptionEnabled,
  getAutoReassignConfig,
  setAutoReassignConfig,
} from "./actions";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Atendimento — workspace-wide inbox preferences.
 *
 * Two toggles today: the agent signature (prefix outgoing messages with the
 * sender's name) and audio transcription (inbound voice notes → text via the
 * account's OpenAI key). Admins-only write; others see disabled controls.
 */
export function ServicePanel() {
  const { canEditSettings } = useAuth();

  const [signature, setSignature] = useState(false);
  const [transcription, setTranscription] = useState(false);
  const [reassign, setReassign] = useState(false);
  const [reassignMin, setReassignMin] = useState(5);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.all([
      getAgentSignatureEnabled(),
      getAudioTranscriptionEnabled(),
      getAutoReassignConfig(),
    ])
      .then(([sig, tr, rc]) => {
        if (!active) return;
        setSignature(sig);
        setTranscription(tr);
        setReassign(rc.enabled);
        setReassignMin(rc.minutes);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div>
      <SettingsPanelHead
        title="Atendimento"
        description="Preferências de como a equipe conversa com os clientes."
      />

      <div className="mt-4 space-y-4">
        <ToggleCard
          icon={<PenLine className="h-4 w-4 text-primary" />}
          title="Assinatura do atendente"
          description="Coloca o nome de quem respondeu no começo de cada mensagem (em negrito), para o cliente saber com quem está falando. Vale só para mensagens enviadas pela equipe no painel — não para a IA nem para a API."
          label="Ativar assinatura"
          hint={
            <>
              Exemplo: <span className="font-semibold">Maria:</span> Boa tarde!
              Como posso ajudar?
            </>
          }
          checked={signature}
          setChecked={setSignature}
          save={setAgentSignatureEnabled}
          onLabel="Assinatura do atendente ativada."
          offLabel="Assinatura do atendente desativada."
          canEdit={canEditSettings}
          loading={loading}
        />

        <ToggleCard
          icon={<AudioLines className="h-4 w-4 text-primary" />}
          title="Transcrição de áudio"
          description="Transcreve automaticamente os áudios recebidos para texto, mostrado abaixo do áudio na conversa. Usa a chave de IA (OpenAI) da sua conta — tem um custo por minuto de áudio."
          label="Transcrever áudios recebidos"
          hint="Precisa de uma chave OpenAI configurada em Agentes IA. Sem chave, o áudio continua chegando normalmente, só sem transcrição."
          checked={transcription}
          setChecked={setTranscription}
          save={setAudioTranscriptionEnabled}
          onLabel="Transcrição de áudio ativada."
          offLabel="Transcrição de áudio desativada."
          canEdit={canEditSettings}
          loading={loading}
        />

        <AutoReassignCard
          enabled={reassign}
          setEnabled={setReassign}
          minutes={reassignMin}
          setMinutes={setReassignMin}
          canEdit={canEditSettings}
          loading={loading}
        />
      </div>
    </div>
  );
}

const MINUTE_OPTIONS = [5, 10, 15, 30, 60];

function AutoReassignCard({
  enabled,
  setEnabled,
  minutes,
  setMinutes,
  canEdit,
  loading,
}: {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  minutes: number;
  setMinutes: (v: number) => void;
  canEdit: boolean;
  loading: boolean;
}) {
  const [saving, setSaving] = useState(false);

  const persist = async (nextEnabled: boolean, nextMinutes: number) => {
    setSaving(true);
    try {
      await setAutoReassignConfig(nextEnabled, nextMinutes);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar.");
      return false;
    } finally {
      setSaving(false);
    }
    return true;
  };

  const onToggle = async (next: boolean) => {
    setEnabled(next);
    const ok = await persist(next, minutes);
    if (!ok) setEnabled(!next);
    else toast.success(next ? "Reatribuição automática ativada." : "Reatribuição automática desativada.");
  };

  const onMinutes = async (val: string) => {
    const m = Number(val);
    const prev = minutes;
    setMinutes(m);
    const ok = await persist(enabled, m);
    if (!ok) setMinutes(prev);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Timer className="h-4 w-4 text-primary" />
          Reatribuição automática (SLA)
        </CardTitle>
        <CardDescription>
          Se uma conversa <strong>sem nenhuma resposta ainda</strong> passar do
          tempo, ela cai automaticamente para outro atendente do mesmo setor (o
          de menor carga) — e ele é notificado. Conversas que o atendente já
          respondeu não são reatribuídas: nesse caso o admin recebe um alerta
          para não deixar o cliente esperando.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 p-3">
          <div className="min-w-0">
            <Label className="text-sm font-medium text-foreground">
              Ativar reatribuição automática
            </Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Só reatribui quando há outro atendente no setor para receber a
              conversa. Senão, avisa o admin.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {(loading || saving) && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
            <Switch
              checked={enabled}
              onCheckedChange={onToggle}
              disabled={!canEdit || loading || saving}
              aria-label="Ativar reatribuição automática"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 p-3">
          <div className="min-w-0">
            <Label className="text-sm font-medium text-foreground">
              Tempo sem resposta
            </Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Depois desse tempo sem o atendente responder, a conversa é
              reatribuída.
            </p>
          </div>
          <Select
            value={String(minutes)}
            onValueChange={(v) => v && void onMinutes(v)}
            disabled={!canEdit || loading || saving || !enabled}
          >
            <SelectTrigger className="w-32 bg-muted border-border text-foreground">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MINUTE_OPTIONS.map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {m} min
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            Só administradores podem alterar esta configuração.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

interface ToggleCardProps {
  icon: ReactNode;
  title: string;
  description: string;
  label: string;
  hint: ReactNode;
  checked: boolean;
  setChecked: (v: boolean) => void;
  save: (v: boolean) => Promise<void>;
  onLabel: string;
  offLabel: string;
  canEdit: boolean;
  loading: boolean;
}

function ToggleCard({
  icon,
  title,
  description,
  label,
  hint,
  checked,
  setChecked,
  save,
  onLabel,
  offLabel,
  canEdit,
  loading,
}: ToggleCardProps) {
  const [saving, setSaving] = useState(false);

  const onToggle = async (next: boolean) => {
    setChecked(next); // optimistic
    setSaving(true);
    try {
      await save(next);
      toast.success(next ? onLabel : offLabel);
    } catch (err) {
      setChecked(!next);
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 p-3">
          <div className="min-w-0">
            <Label className="text-sm font-medium text-foreground">{label}</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {(loading || saving) && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
            <Switch
              checked={checked}
              onCheckedChange={onToggle}
              disabled={!canEdit || loading || saving}
              aria-label={label}
            />
          </div>
        </div>
        {!canEdit && (
          <p className="mt-2 text-xs text-muted-foreground">
            Só administradores podem alterar esta configuração.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
