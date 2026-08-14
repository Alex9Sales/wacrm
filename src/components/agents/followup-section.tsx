'use client';

// ============================================================
// Follow-up inteligente — seção na config do agente. Quando o cliente fica um
// tempo sem responder, a IA manda UMA mensagem de reengajamento (gerada com o
// contexto da conversa). Desligado por padrão; ao ligar, "arma" e só vale pra
// conversas novas. Backend: /api/ai/followup. Motor: worker (tick 5 min).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Clock3, Loader2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';

type Unit = 'minutes' | 'hours' | 'days';

function toDisplay(minutes: number): { value: number; unit: Unit } {
  if (minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
  if (minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
  return { value: minutes, unit: 'minutes' };
}
function toMinutes(value: number, unit: Unit): number {
  const v = Math.max(1, Math.round(value || 0));
  if (unit === 'days') return v * 1440;
  if (unit === 'hours') return v * 60;
  return v;
}

export function FollowUpSection({ agentId }: { agentId: string }) {
  const { accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [enabled, setEnabled] = useState(false);
  const [value, setValue] = useState(1);
  const [unit, setUnit] = useState<Unit>('hours');
  const [instructions, setInstructions] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ai/followup?agent=${encodeURIComponent(agentId)}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.followUp) {
        setEnabled(!!data.followUp.enabled);
        const d = toDisplay(Number(data.followUp.delayMinutes) || 60);
        setValue(d.value);
        setUnit(d.unit);
        setInstructions(data.followUp.instructions ?? '');
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

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/ai/followup', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: agentId,
          enabled,
          delayMinutes: toMinutes(value, unit),
          instructions: instructions.trim(),
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
              Quando o cliente fica um tempo sem responder, a IA manda{' '}
              <strong>uma</strong> mensagem de reengajamento (com o contexto da
              conversa). Só dispara <strong>1 vez por silêncio</strong> — volta a
              valer depois que o cliente responder. Respeita o horário de
              atendimento e a janela de 24h do WhatsApp.
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
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label htmlFor="fu-delay">Enviar após</Label>
              <div className="mt-1 flex items-center gap-2">
                <Input
                  id="fu-delay"
                  type="number"
                  min={1}
                  value={value}
                  onChange={(e) => setValue(Number(e.target.value))}
                  className="h-9 w-24"
                  disabled={!canEdit}
                />
                <select
                  value={unit}
                  onChange={(e) => setUnit(e.target.value as Unit)}
                  disabled={!canEdit}
                  className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                >
                  <option value="minutes">minutos</option>
                  <option value="hours">horas</option>
                  <option value="days">dias</option>
                </select>
                <span className="text-xs text-muted-foreground">sem resposta</span>
              </div>
            </div>
          </div>
          <div>
            <Label htmlFor="fu-instr">O que dizer (orientação)</Label>
            <Textarea
              id="fu-instr"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={3}
              disabled={!canEdit}
              placeholder="ex.: Retome de forma leve, pergunte se ainda tem interesse e ofereça agendar uma demo. Não force."
              className="mt-1"
            />
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
