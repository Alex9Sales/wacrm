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

export function FollowUpSection({ agentId }: { agentId: string }) {
  const { accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [enabled, setEnabled] = useState(false);
  const [steps, setSteps] = useState<Step[]>([
    { delayValue: 1, delayUnit: 'hours', instructions: '' },
  ]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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
