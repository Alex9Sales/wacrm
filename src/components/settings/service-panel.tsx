"use client";

import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2, PenLine, AudioLines, Timer, Clock, Star } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import {
  getAgentSignatureEnabled,
  setAgentSignatureEnabled,
  getAudioTranscriptionEnabled,
  setAudioTranscriptionEnabled,
  getAutoReassignConfig,
  setAutoReassignConfig,
  getBusinessHoursConfig,
  setBusinessHoursConfig,
  type BusinessHoursConfig,
  getCsatConfig,
  setCsatConfig,
  type CsatConfig,
} from "./actions";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
  const [businessHours, setBusinessHours] = useState<BusinessHoursConfig | null>(
    null,
  );
  const [csat, setCsat] = useState<CsatConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.all([
      getAgentSignatureEnabled(),
      getAudioTranscriptionEnabled(),
      getAutoReassignConfig(),
      getBusinessHoursConfig(),
      getCsatConfig(),
    ])
      .then(([sig, tr, rc, bh, cs]) => {
        if (!active) return;
        setSignature(sig);
        setTranscription(tr);
        setReassign(rc.enabled);
        setReassignMin(rc.minutes);
        setBusinessHours(bh);
        setCsat(cs);
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

        <BusinessHoursCard
          initial={businessHours}
          canEdit={canEditSettings}
          loading={loading}
        />

        <CsatCard initial={csat} canEdit={canEditSettings} loading={loading} />
      </div>
    </div>
  );
}

function CsatCard({
  initial,
  canEdit,
  loading,
}: {
  initial: CsatConfig | null;
  canEdit: boolean;
  loading: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [question, setQuestion] = useState("");
  const [thanks, setThanks] = useState("");
  const [commentPrompt, setCommentPrompt] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!initial) return;
    setEnabled(initial.enabled);
    setQuestion(initial.question);
    setThanks(initial.thanks);
    setCommentPrompt(initial.commentPrompt);
  }, [initial]);

  const save = async () => {
    setSaving(true);
    try {
      await setCsatConfig({ enabled, question, thanks, commentPrompt });
      toast.success("Pesquisa de satisfação salva.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Star className="h-4 w-4 text-primary" />
          Pesquisa de satisfação (CSAT)
        </CardTitle>
        <CardDescription>
          Ao fechar uma conversa, pergunta ao cliente uma nota de 1 a 5. A
          resposta é registrada e aparece no relatório da Supervisão.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 p-3">
          <Label className="text-sm font-medium text-foreground">
            Ativar pesquisa ao fechar conversa
          </Label>
          <div className="flex shrink-0 items-center gap-2">
            {(loading || saving) && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={!canEdit || loading || saving}
              aria-label="Ativar pesquisa de satisfação"
            />
          </div>
        </div>

        {enabled && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="csat-q">Pergunta enviada</Label>
              <textarea
                id="csat-q"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                rows={2}
                disabled={!canEdit}
                className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50 disabled:opacity-50"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="csat-c">Pedido de comentário (após a nota)</Label>
              <textarea
                id="csat-c"
                value={commentPrompt}
                onChange={(e) => setCommentPrompt(e.target.value)}
                rows={2}
                disabled={!canEdit}
                className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50 disabled:opacity-50"
              />
              <p className="text-xs text-muted-foreground">
                Após a nota, o cliente recebe isso e a próxima mensagem dele vira
                o comentário (aparece na Supervisão, com quem atendeu).
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="csat-t">Agradecimento (após o comentário)</Label>
              <textarea
                id="csat-t"
                value={thanks}
                onChange={(e) => setThanks(e.target.value)}
                rows={2}
                disabled={!canEdit}
                className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50 disabled:opacity-50"
              />
            </div>
          </>
        )}

        {canEdit && (
          <div className="flex justify-end">
            <Button onClick={save} disabled={saving || loading}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Salvar pesquisa
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const WEEKDAYS = [
  "Domingo",
  "Segunda",
  "Terça",
  "Quarta",
  "Quinta",
  "Sexta",
  "Sábado",
];

// Fusos do Brasil (o horário de atendimento é avaliado NESTE fuso, não no do
// navegador de quem configurou). Cada conta escolhe o da sua região — ex.: o
// CEMA fica no Rio (GMT-3), não em Campo Grande (GMT-4).
const TIMEZONE_OPTIONS: { value: string; label: string }[] = [
  { value: "America/Sao_Paulo", label: "Brasília · SP · RJ · Sul/Sudeste/NE (GMT-3)" },
  { value: "America/Campo_Grande", label: "Mato Grosso do Sul (GMT-4)" },
  { value: "America/Cuiaba", label: "Mato Grosso (GMT-4)" },
  { value: "America/Manaus", label: "Amazonas · Roraima (GMT-4)" },
  { value: "America/Porto_Velho", label: "Rondônia (GMT-4)" },
  { value: "America/Boa_Vista", label: "Roraima (GMT-4)" },
  { value: "America/Belem", label: "Pará · Amapá (GMT-3)" },
  { value: "America/Fortaleza", label: "Ceará · Nordeste (GMT-3)" },
  { value: "America/Recife", label: "Pernambuco (GMT-3)" },
  { value: "America/Bahia", label: "Bahia (GMT-3)" },
  { value: "America/Rio_Branco", label: "Acre (GMT-5)" },
  { value: "America/Noronha", label: "Fernando de Noronha (GMT-2)" },
];

function BusinessHoursCard({
  initial,
  canEdit,
  loading,
}: {
  initial: BusinessHoursConfig | null;
  canEdit: boolean;
  loading: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState<BusinessHoursConfig["days"]>([]);
  const [message, setMessage] = useState("");
  const [timezone, setTimezone] = useState("America/Sao_Paulo");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!initial) return;
    setEnabled(initial.enabled);
    setDays(initial.days);
    setMessage(initial.message);
    setTimezone(initial.timezone || "America/Sao_Paulo");
  }, [initial]);

  const setDay = (
    i: number,
    patch: Partial<BusinessHoursConfig["days"][number]>,
  ) =>
    setDays((prev) =>
      prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)),
    );

  const toggleDay = (i: number, open: boolean) =>
    setDay(i, open ? { open: "08:00", close: "18:00" } : { open: null, close: null });

  const save = async () => {
    setSaving(true);
    try {
      await setBusinessHoursConfig({
        enabled,
        days,
        timezone,
        message,
      });
      toast.success("Horário de atendimento salvo.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4 text-primary" />
          Horário de atendimento
        </CardTitle>
        <CardDescription>
          Fora do horário, responde o cliente automaticamente com a mensagem
          abaixo (uma vez por conversa). Útil pra não deixar ninguém sem
          resposta de madrugada ou no fim de semana.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 p-3">
          <Label className="text-sm font-medium text-foreground">
            Ativar horário de atendimento
          </Label>
          <div className="flex shrink-0 items-center gap-2">
            {(loading || saving) && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={!canEdit || loading || saving}
              aria-label="Ativar horário de atendimento"
            />
          </div>
        </div>

        {enabled && (
          <>
            {/* Fuso horário — o horário abaixo é avaliado NESTE fuso, não no do
                navegador. Cada conta escolhe o da sua região (o CEMA no Rio,
                GMT-3; não em Campo Grande). */}
            <div className="space-y-1.5">
              <Label htmlFor="ooh-tz">Fuso horário do atendimento</Label>
              <select
                id="ooh-tz"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                disabled={!canEdit}
                className="h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm text-foreground outline-none focus:border-primary/50 disabled:opacity-50"
              >
                {TIMEZONE_OPTIONS.some((o) => o.value === timezone) ? null : (
                  <option value={timezone}>{timezone}</option>
                )}
                {TIMEZONE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Os horários abaixo valem neste fuso. Ajuste pra região da sua
                empresa — assim o cliente não recebe &quot;fora do horário&quot;
                por diferença de fuso.
              </p>
            </div>

            <div className="space-y-2">
              {days.map((d, i) => {
                const isOpen = !!(d.open && d.close);
                return (
                  <div key={i} className="flex items-center gap-3">
                    <div className="flex w-28 items-center gap-2">
                      <Switch
                        checked={isOpen}
                        onCheckedChange={(v) => toggleDay(i, v)}
                        disabled={!canEdit}
                        aria-label={`Abrir ${WEEKDAYS[i]}`}
                      />
                      <span className="text-sm text-foreground">{WEEKDAYS[i]}</span>
                    </div>
                    {isOpen ? (
                      <div className="flex items-center gap-2">
                        <Input
                          type="time"
                          value={d.open ?? ""}
                          onChange={(e) => setDay(i, { open: e.target.value })}
                          disabled={!canEdit}
                          className="w-28"
                        />
                        <span className="text-muted-foreground">até</span>
                        <Input
                          type="time"
                          value={d.close ?? ""}
                          onChange={(e) => setDay(i, { close: e.target.value })}
                          disabled={!canEdit}
                          className="w-28"
                        />
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">Fechado</span>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ooh-msg">Mensagem fora do horário</Label>
              <textarea
                id="ooh-msg"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                disabled={!canEdit}
                className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50 disabled:opacity-50"
              />
            </div>
          </>
        )}

        {canEdit && (
          <div className="flex justify-end">
            <Button onClick={save} disabled={saving || loading}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Salvar horário
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
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
