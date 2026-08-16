'use client';

// ============================================================
// Follow-up inteligente em ESCADA (v2) — seção na config do agente. Quando o
// cliente fica sem responder, a IA manda uma sequência de toques (degraus) com
// cadência crescente, cada um com sua orientação. Desligado por padrão; ao ligar
// "arma" (só conversas novas). Backend: /api/ai/followup. Motor: worker (5 min).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Clock3, Loader2, Plus, Trash2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { listApprovedTemplates } from '@/app/(dashboard)/inbox/actions';
import type { MessageTemplate } from '@/types';

/** Quantos parâmetros {{n}} o corpo do template tem (maior índice). */
function templateParamCount(bodyText: string): number {
  let max = 0;
  for (const m of bodyText.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    max = Math.max(max, Number(m[1]) || 0);
  }
  return max;
}

type Unit = 'minutes' | 'hours' | 'days';
interface Step {
  delayValue: number;
  delayUnit: Unit;
  instructions: string;
  /** Só UI: mostra o campo de orientação (opcional). Não vai pro backend. */
  _guide?: boolean;
}

const MAX_STEPS = 5;
const NEW_STEP: Step = { delayValue: 1, delayUnit: 'days', instructions: '' };

interface StageTrig {
  stage: string;
  delayValue: number;
  delayUnit: Unit;
  instructions: string;
  /** Template aprovado usado fora da janela de 24h (canal oficial). */
  templateName: string;
  templateLanguage: string;
  /** Params do template, separados por vírgula (tokens {nome} {hora} {data}). */
  templateParamsText: string;
  /** Só UI: mostra o campo de orientação. */
  _guide?: boolean;
}

const MAX_STAGE_TRIGGERS = 6;
const MAX_MEETING_REMINDERS = 6;

interface MeetingRem {
  offsetValue: number;
  offsetUnit: Unit;
  when: 'before' | 'after';
  instructions: string;
  templateName: string;
  templateLanguage: string;
  templateParamsText: string;
}

/** Lembretes padrão (estilo n8n): 24h, 12h, 1h antes + 2h depois. */
const MEETING_DEFAULTS: MeetingRem[] = [
  { offsetValue: 24, offsetUnit: 'hours', when: 'before', instructions: '', templateName: '', templateLanguage: '', templateParamsText: '' },
  { offsetValue: 12, offsetUnit: 'hours', when: 'before', instructions: '', templateName: '', templateLanguage: '', templateParamsText: '' },
  { offsetValue: 1, offsetUnit: 'hours', when: 'before', instructions: '', templateName: '', templateLanguage: '', templateParamsText: '' },
  { offsetValue: 2, offsetUnit: 'hours', when: 'after', instructions: '', templateName: '', templateLanguage: '', templateParamsText: '' },
];
/** Opções prontas (o "tem opções ou escreve" do Alex): preenche um gatilho que
 *  o usuário edita (nome da etapa + tempo). */
const EMPTY_TEMPLATE = { templateName: '', templateLanguage: '', templateParamsText: '' };
const STAGE_PRESETS: { label: string; trig: StageTrig }[] = [
  {
    label: 'Confirmar reunião',
    trig: {
      stage: 'Agendado',
      delayValue: 3,
      delayUnit: 'hours',
      instructions: 'Confirme a reunião combinada (dia e horário) e peça pro cliente confirmar se está de pé.',
      ...EMPTY_TEMPLATE,
      _guide: true,
    },
  },
  {
    label: 'Remarcar (faltou)',
    trig: {
      stage: 'No-show',
      delayValue: 2,
      delayUnit: 'hours',
      instructions: 'Diga que sentiu falta do cliente na reunião e ofereça remarcar pra um novo horário.',
      ...EMPTY_TEMPLATE,
      _guide: true,
    },
  },
  {
    label: 'Pós-reunião',
    trig: {
      stage: 'Compareceu',
      delayValue: 1,
      delayUnit: 'days',
      instructions: 'Agradeça a presença, pergunte se ficou alguma dúvida e puxe o próximo passo.',
      ...EMPTY_TEMPLATE,
      _guide: true,
    },
  },
];

export function FollowUpSection({ agentId }: { agentId: string }) {
  const { accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [enabled, setEnabled] = useState(false);
  const [steps, setSteps] = useState<Step[]>([
    { delayValue: 1, delayUnit: 'hours', instructions: '' },
  ]);
  const [giveUpEnabled, setGiveUpEnabled] = useState(false);
  const [giveUpStage, setGiveUpStage] = useState('');
  const [stageTriggers, setStageTriggers] = useState<StageTrig[]>([]);
  const [meetingRems, setMeetingRems] = useState<MeetingRem[]>([]);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listApprovedTemplates()
      .then((t) => setTemplates(t))
      .catch(() => setTemplates([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ai/followup?agent=${encodeURIComponent(agentId)}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.followUp) {
        setEnabled(!!data.followUp.enabled);
        const s = Array.isArray(data.followUp.steps) ? data.followUp.steps : [];
        setSteps(
          s.length > 0
            ? s.map((x: Step) => ({
                delayValue: Number(x.delayValue) || 1,
                delayUnit: (['minutes', 'hours', 'days'] as Unit[]).includes(x.delayUnit)
                  ? x.delayUnit
                  : 'hours',
                instructions: x.instructions ?? '',
                // Já orientado? mostra o campo aberto; senão fica escondido.
                _guide: !!(x.instructions ?? '').trim(),
              }))
            : [{ delayValue: 1, delayUnit: 'hours', instructions: '' }],
        );
        setGiveUpEnabled(!!data.followUp.giveUpEnabled);
        setGiveUpStage(
          typeof data.followUp.giveUpStage === 'string' ? data.followUp.giveUpStage : '',
        );
        const st = Array.isArray(data.followUp.stageTriggers)
          ? data.followUp.stageTriggers
          : [];
        setStageTriggers(
          st.map((x: Record<string, unknown>) => ({
            stage: typeof x.stage === 'string' ? x.stage : '',
            delayValue: Number(x.delayValue) || 1,
            delayUnit: (['minutes', 'hours', 'days'] as Unit[]).includes(
              x.delayUnit as Unit,
            )
              ? (x.delayUnit as Unit)
              : 'hours',
            instructions: (x.instructions as string) ?? '',
            templateName: (x.templateName as string) ?? '',
            templateLanguage: (x.templateLanguage as string) ?? '',
            templateParamsText: Array.isArray(x.templateParams)
              ? (x.templateParams as string[]).join(', ')
              : '',
            _guide: !!((x.instructions as string) ?? '').trim(),
          })),
        );
        const mr = Array.isArray(data.followUp.meetingReminders)
          ? data.followUp.meetingReminders
          : [];
        setMeetingRems(
          mr.map((x: Record<string, unknown>) => ({
            offsetValue: Number(x.offsetValue) || 1,
            offsetUnit: (['minutes', 'hours', 'days'] as Unit[]).includes(
              x.offsetUnit as Unit,
            )
              ? (x.offsetUnit as Unit)
              : 'hours',
            when: x.when === 'after' ? 'after' : 'before',
            instructions: (x.instructions as string) ?? '',
            templateName: (x.templateName as string) ?? '',
            templateLanguage: (x.templateLanguage as string) ?? '',
            templateParamsText: Array.isArray(x.templateParams)
              ? (x.templateParams as string[]).join(', ')
              : '',
          })),
        );
      }
    } catch {
      /* best-effort */
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const setStep = (i: number, patch: Partial<Step>) =>
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const addStep = () =>
    setSteps((prev) => (prev.length >= MAX_STEPS ? prev : [...prev, { ...NEW_STEP }]));
  const removeStep = (i: number) =>
    setSteps((prev) => (prev.length <= 1 ? prev : prev.filter((_, j) => j !== i)));

  const setTrig = (i: number, patch: Partial<StageTrig>) =>
    setStageTriggers((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const addTrig = (t?: StageTrig) =>
    setStageTriggers((prev) =>
      prev.length >= MAX_STAGE_TRIGGERS
        ? prev
        : [
            ...prev,
            t ?? {
              stage: '',
              delayValue: 3,
              delayUnit: 'hours',
              instructions: '',
              templateName: '',
              templateLanguage: '',
              templateParamsText: '',
            },
          ],
    );
  const removeTrig = (i: number) =>
    setStageTriggers((prev) => prev.filter((_, j) => j !== i));

  const setRem = (i: number, patch: Partial<MeetingRem>) =>
    setMeetingRems((prev) => prev.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const addRem = () =>
    setMeetingRems((prev) =>
      prev.length >= MAX_MEETING_REMINDERS
        ? prev
        : [
            ...prev,
            {
              offsetValue: 1,
              offsetUnit: 'hours',
              when: 'before',
              instructions: '',
              templateName: '',
              templateLanguage: '',
              templateParamsText: '',
            },
          ],
    );
  const removeRem = (i: number) =>
    setMeetingRems((prev) => prev.filter((_, j) => j !== i));
  const addRemDefaults = () =>
    setMeetingRems((prev) =>
      prev.length > 0 ? prev : MEETING_DEFAULTS.map((m) => ({ ...m })),
    );

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/ai/followup', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: agentId,
          enabled,
          steps: steps.map((s) => ({
            delayValue: Math.max(1, Math.round(s.delayValue || 1)),
            delayUnit: s.delayUnit,
            instructions: s.instructions.trim(),
          })),
          giveUpEnabled,
          giveUpStage: giveUpStage.trim(),
          stageTriggers: stageTriggers
            .filter((t) => t.stage.trim())
            .map((t) => ({
              stage: t.stage.trim(),
              delayValue: Math.max(1, Math.round(t.delayValue || 1)),
              delayUnit: t.delayUnit,
              instructions: t.instructions.trim(),
              templateName: t.templateName.trim(),
              templateLanguage: t.templateLanguage.trim(),
              templateParams: t.templateParamsText
                .split(',')
                .map((p) => p.trim())
                .filter(Boolean),
            })),
          meetingReminders: meetingRems.map((m) => ({
            offsetValue: Math.max(0, Math.round(m.offsetValue || 1)),
            offsetUnit: m.offsetUnit,
            when: m.when,
            instructions: m.instructions.trim(),
            templateName: m.templateName.trim(),
            templateLanguage: m.templateLanguage.trim(),
            templateParams: m.templateParamsText
              .split(',')
              .map((p) => p.trim())
              .filter(Boolean),
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) toast.success('Follow-up salvo.');
      else toast.error(data.error ?? 'Falha ao salvar.');
    } catch {
      toast.error('Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Clock3 className="h-4.5 w-4.5" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">
              Follow-up inteligente
            </p>
            <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
              Quando o cliente some, a IA volta a falar sozinha. <strong>Você não
              precisa escrever nada</strong> — é só ligar e definir de quanto em
              quanto tempo ela dá um toque. Cada mensagem é gerada com o contexto
              da conversa. Volta pro início quando o cliente responder e respeita o
              horário de atendimento. (Se quiser, dá pra orientar o que dizer, mas
              é opcional.)
            </p>
          </div>
        </div>
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!canEdit} />
        )}
      </div>

      {enabled && !loading && (
        <div className="mt-4 space-y-3 border-t border-border pt-3">
          <p className="rounded-lg bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
            O follow-up só reengaja quem <strong>realmente sumiu</strong>: ele
            não roda se o lead já <strong>agendou uma reunião</strong> ou o
            negócio foi <strong>ganho/perdido</strong>. Volta pro início quando o
            cliente responde.
          </p>
          {steps.map((s, i) => (
            <div key={i} className="rounded-lg border border-border p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    Toque {i + 1}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {i === 0 ? 'após' : 'e depois de mais'}
                  </span>
                  <Input
                    type="number"
                    min={1}
                    value={s.delayValue}
                    onChange={(e) => setStep(i, { delayValue: Number(e.target.value) })}
                    className="h-8 w-20"
                    disabled={!canEdit}
                  />
                  <select
                    value={s.delayUnit}
                    onChange={(e) => setStep(i, { delayUnit: e.target.value as Unit })}
                    disabled={!canEdit}
                    className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                  >
                    <option value="minutes">minutos</option>
                    <option value="hours">horas</option>
                    <option value="days">dias</option>
                  </select>
                  <span className="text-xs text-muted-foreground">
                    {i === 0 ? 'sem resposta' : 'sem resposta'}
                  </span>
                </div>
                {canEdit && steps.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeStep(i)}
                    className="text-muted-foreground hover:text-destructive"
                    title="Remover toque"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              {s._guide ? (
                <div className="mt-1">
                  <div className="flex items-center justify-between">
                    <Label
                      htmlFor={`fu-instr-${i}`}
                      className="text-[11px] text-muted-foreground"
                    >
                      Orientação (opcional) — o que dizer neste toque
                    </Label>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => setStep(i, { instructions: '', _guide: false })}
                        className="text-[11px] text-muted-foreground hover:text-destructive"
                      >
                        remover
                      </button>
                    )}
                  </div>
                  <Textarea
                    id={`fu-instr-${i}`}
                    value={s.instructions}
                    onChange={(e) => setStep(i, { instructions: e.target.value })}
                    rows={2}
                    disabled={!canEdit}
                    placeholder={
                      i === 0
                        ? 'ex.: Retome leve, pergunte se ainda tem interesse.'
                        : 'ex.: Reforce o benefício e ofereça agendar uma demo.'
                    }
                    className="mt-1"
                  />
                </div>
              ) : (
                canEdit && (
                  <button
                    type="button"
                    onClick={() => setStep(i, { _guide: true })}
                    className="text-xs text-primary hover:underline"
                  >
                    + Orientar o que dizer (opcional)
                  </button>
                )
              )}
            </div>
          ))}

          {canEdit && steps.length < MAX_STEPS && (
            <Button variant="outline" size="sm" onClick={addStep}>
              <Plus className="mr-1.5 h-4 w-4" /> Adicionar toque
            </Button>
          )}

          {/* Desistência: sem resposta até o último toque → move pra Perdido. */}
          <div className="rounded-lg border border-dashed border-border p-3">
            <label className="flex items-center gap-2.5 text-sm font-medium text-foreground">
              <Switch
                checked={giveUpEnabled}
                onCheckedChange={setGiveUpEnabled}
                disabled={!canEdit}
              />
              Desistir depois do último toque
            </label>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Se o cliente não responder até o último toque, move o card do funil
              pra uma etapa e para de insistir.
            </p>
            {giveUpEnabled && (
              <div className="mt-2">
                <Label
                  htmlFor="fu-giveup-stage"
                  className="text-[11px] text-muted-foreground"
                >
                  Mover o card para a etapa:
                </Label>
                <Input
                  id="fu-giveup-stage"
                  value={giveUpStage}
                  onChange={(e) => setGiveUpStage(e.target.value)}
                  placeholder="ex.: Perdido"
                  disabled={!canEdit}
                  className="mt-1 h-8 max-w-xs"
                />
              </div>
            )}
          </div>

          {/* Follow-up por ETAPA (Fase E): gatilho quando o card ENTRA numa etapa. */}
          <div className="rounded-lg border border-dashed border-border p-3">
            <p className="text-sm font-medium text-foreground">Follow-up por etapa</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Quando o card entra numa etapa, a IA dá um toque depois de um tempo
              (ex.: entrou em <strong>Agendado</strong> → confirma a reunião). Só
              dispara se o cliente estiver calado e dentro da janela de 24h.
            </p>

            {stageTriggers.map((t, i) => (
              <div key={i} className="mt-2 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                  <span className="text-xs text-muted-foreground">Quando entrar em</span>
                  <Input
                    value={t.stage}
                    onChange={(e) => setTrig(i, { stage: e.target.value })}
                    placeholder="etapa (ex.: Agendado)"
                    disabled={!canEdit}
                    className="h-8 w-44"
                  />
                  <span className="text-xs text-muted-foreground">após</span>
                  <Input
                    type="number"
                    min={1}
                    value={t.delayValue}
                    onChange={(e) => setTrig(i, { delayValue: Number(e.target.value) })}
                    className="h-8 w-20"
                    disabled={!canEdit}
                  />
                  <select
                    value={t.delayUnit}
                    onChange={(e) => setTrig(i, { delayUnit: e.target.value as Unit })}
                    disabled={!canEdit}
                    className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                  >
                    <option value="minutes">minutos</option>
                    <option value="hours">horas</option>
                    <option value="days">dias</option>
                  </select>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => removeTrig(i)}
                      className="ml-auto text-muted-foreground hover:text-destructive"
                      title="Remover etapa"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {t._guide ? (
                  <div className="mt-2">
                    <div className="flex items-center justify-between">
                      <Label
                        htmlFor={`st-instr-${i}`}
                        className="text-[11px] text-muted-foreground"
                      >
                        Orientação (opcional) — o que dizer
                      </Label>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => setTrig(i, { instructions: '', _guide: false })}
                          className="text-[11px] text-muted-foreground hover:text-destructive"
                        >
                          remover
                        </button>
                      )}
                    </div>
                    <Textarea
                      id={`st-instr-${i}`}
                      value={t.instructions}
                      onChange={(e) => setTrig(i, { instructions: e.target.value })}
                      rows={2}
                      disabled={!canEdit}
                      placeholder="ex.: Confirme o dia e horário da reunião e peça a confirmação."
                      className="mt-1"
                    />
                  </div>
                ) : (
                  canEdit && (
                    <button
                      type="button"
                      onClick={() => setTrig(i, { _guide: true })}
                      className="mt-1 text-xs text-primary hover:underline"
                    >
                      + Orientar o que dizer (opcional)
                    </button>
                  )
                )}

                {/* Modelo aprovado: usado quando estiver FORA da janela de 24h
                    no canal OFICIAL (Meta). Dentro da janela = texto da IA. */}
                <div className="mt-2 border-t border-dashed border-border pt-2">
                  <Label className="text-[11px] text-muted-foreground">
                    Modelo p/ fora da janela de 24h (canal oficial)
                  </Label>
                  <select
                    value={
                      t.templateName
                        ? `${t.templateName}|${t.templateLanguage}`
                        : ''
                    }
                    onChange={(e) => {
                      const [name, lang] = e.target.value.split('|');
                      setTrig(i, {
                        templateName: name || '',
                        templateLanguage: lang || '',
                      });
                    }}
                    disabled={!canEdit}
                    className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                  >
                    <option value="">
                      — sem modelo (não envia fora da janela) —
                    </option>
                    {templates.map((tp) => (
                      <option key={tp.id} value={`${tp.name}|${tp.language ?? ''}`}>
                        {tp.name} ({tp.language}) ·{' '}
                        {templateParamCount(tp.body_text)} parâm.
                      </option>
                    ))}
                  </select>
                  {t.templateName && (
                    <>
                      <Input
                        value={t.templateParamsText}
                        onChange={(e) =>
                          setTrig(i, { templateParamsText: e.target.value })
                        }
                        placeholder="params por vírgula — ex.: {nome}, {hora}"
                        disabled={!canEdit}
                        className="mt-1 h-8"
                      />
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        Um valor por parâmetro do modelo. Tokens:{' '}
                        <strong>{'{nome}'}</strong> (contato),{' '}
                        <strong>{'{hora}'}</strong> e <strong>{'{data}'}</strong>{' '}
                        (próxima reunião).
                      </p>
                    </>
                  )}
                </div>
              </div>
            ))}

            {canEdit && stageTriggers.length < MAX_STAGE_TRIGGERS && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => addTrig()}>
                  <Plus className="mr-1.5 h-4 w-4" /> Adicionar etapa
                </Button>
                {STAGE_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => addTrig({ ...p.trig })}
                    className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
                  >
                    + {p.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Lembretes de reunião — ancorados no HORÁRIO do evento agendado. */}
          <div className="rounded-lg border border-dashed border-border p-3">
            <p className="text-sm font-medium text-foreground">
              Lembretes de reunião
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Ancorados no <strong>horário da reunião</strong> agendada (ex.: 24h
              antes, 1h antes, 2h depois). Dentro da janela de 24h vai texto da IA;
              fora dela (canal oficial) usa o modelo.
            </p>

            {meetingRems.map((m, i) => (
              <div key={i} className="mt-2 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                  <Input
                    type="number"
                    min={0}
                    value={m.offsetValue}
                    onChange={(e) => setRem(i, { offsetValue: Number(e.target.value) })}
                    className="h-8 w-20"
                    disabled={!canEdit}
                  />
                  <select
                    value={m.offsetUnit}
                    onChange={(e) => setRem(i, { offsetUnit: e.target.value as Unit })}
                    disabled={!canEdit}
                    className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                  >
                    <option value="minutes">minutos</option>
                    <option value="hours">horas</option>
                    <option value="days">dias</option>
                  </select>
                  <select
                    value={m.when}
                    onChange={(e) =>
                      setRem(i, { when: e.target.value as 'before' | 'after' })
                    }
                    disabled={!canEdit}
                    className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                  >
                    <option value="before">antes da reunião</option>
                    <option value="after">depois da reunião</option>
                  </select>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => removeRem(i)}
                      className="ml-auto text-muted-foreground hover:text-destructive"
                      title="Remover lembrete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <Input
                  value={m.instructions}
                  onChange={(e) => setRem(i, { instructions: e.target.value })}
                  placeholder="Orientação (opcional) — o que dizer neste lembrete"
                  disabled={!canEdit}
                  className="mt-2 h-8"
                />
                <div className="mt-2 border-t border-dashed border-border pt-2">
                  <Label className="text-[11px] text-muted-foreground">
                    Modelo p/ fora da janela de 24h (canal oficial)
                  </Label>
                  <select
                    value={
                      m.templateName
                        ? `${m.templateName}|${m.templateLanguage}`
                        : ''
                    }
                    onChange={(e) => {
                      const [name, lang] = e.target.value.split('|');
                      setRem(i, {
                        templateName: name || '',
                        templateLanguage: lang || '',
                      });
                    }}
                    disabled={!canEdit}
                    className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                  >
                    <option value="">— sem modelo —</option>
                    {templates.map((tp) => (
                      <option key={tp.id} value={`${tp.name}|${tp.language ?? ''}`}>
                        {tp.name} ({tp.language}) ·{' '}
                        {templateParamCount(tp.body_text)} parâm.
                      </option>
                    ))}
                  </select>
                  {m.templateName && (
                    <Input
                      value={m.templateParamsText}
                      onChange={(e) =>
                        setRem(i, { templateParamsText: e.target.value })
                      }
                      placeholder="params por vírgula — ex.: {nome}, {hora}"
                      disabled={!canEdit}
                      className="mt-1 h-8"
                    />
                  )}
                </div>
              </div>
            ))}

            {canEdit && meetingRems.length < MAX_MEETING_REMINDERS && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={addRem}>
                  <Plus className="mr-1.5 h-4 w-4" /> Adicionar lembrete
                </Button>
                {meetingRems.length === 0 && (
                  <button
                    type="button"
                    onClick={addRemDefaults}
                    className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
                  >
                    + Lembretes padrão (24h, 12h, 1h antes + 2h depois)
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {canEdit && !loading && (
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar follow-up
          </Button>
        </div>
      )}
    </div>
  );
}
