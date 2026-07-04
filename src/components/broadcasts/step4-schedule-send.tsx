'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  estimateAudienceCount,
  type BroadcastChannel,
} from '@/app/(dashboard)/broadcasts/actions';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  Send,
  Loader2,
  Users,
  Save,
  CalendarClock,
  Smartphone,
} from 'lucide-react';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  /** Meta channels the account can send from (loaded by the wizard). */
  channels: BroadcastChannel[];
  channelId: string;
  onChannelChange: (channelId: string) => void;
  /** ISO string or '' for "send now". Bound to a datetime-local input. */
  scheduledAt: string;
  onScheduledAtChange: (iso: string) => void;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

/**
 * Convert a <input type="datetime-local"> value (local wall-clock, no
 * zone) to an ISO/UTC string, and back. The picker speaks local time;
 * the API wants ISO. Empty ⇄ empty ("send now").
 */
function localInputToIso(local: string): string {
  if (!local) return '';
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function isoToLocalInput(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // Shift by the local tz offset so the wall-clock time round-trips.
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

/** Now, as a datetime-local min value (blocks scheduling in the past). */
function nowLocalInput(): string {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  channels,
  channelId,
  onChannelChange,
  scheduledAt,
  onScheduledAtChange,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        if (audience.type === 'csv') {
          setEstimatedReach(audience.csvContacts?.length ?? 0);
        } else if (audience.type === 'all') {
          const n = await estimateAudienceCount({ type: 'all' });
          setEstimatedReach(n ?? 0);
        } else if (
          audience.type === 'tags' &&
          audience.tagIds &&
          audience.tagIds.length > 0
        ) {
          const n = await estimateAudienceCount({
            type: 'tags',
            tagIds: audience.tagIds,
          });
          setEstimatedReach(n ?? 0);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? 'Todos os contatos'
      : audience.type === 'tags'
        ? `Tags (${audience.tagIds?.length ?? 0} selecionadas)`
        : audience.type === 'csv'
          ? 'Upload CSV'
          : 'Personalizado';

  // With a single Meta channel the picker is hidden and that channel is
  // defaulted silently; with more than one the user must choose.
  const showChannelPicker = channels.length > 1;
  const scheduledLocal = useMemo(
    () => isoToLocalInput(scheduledAt),
    [scheduledAt],
  );
  const isScheduled = Boolean(scheduledAt);
  const scheduledLabel = isScheduled
    ? new Date(scheduledAt).toLocaleString('pt-BR', {
        dateStyle: 'short',
        timeStyle: 'short',
      })
    : null;

  const noChannel = channels.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          Revisar e enviar
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Dê um nome, revise os detalhes e envie ou agende o disparo.
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">
          Nome do broadcast
        </label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="ex.: Anúncio da promoção de inverno"
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Channel picker — only when the account has more than one Meta
          channel. A broadcast is Meta-only (templates live there). */}
      {showChannelPicker && (
        <div>
          <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
            Canal de envio
          </label>
          <select
            value={channelId}
            onChange={(e) => onChannelChange(e.target.value)}
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {channels.map((ch) => (
              <option key={ch.id} value={ch.id}>
                {ch.name}
                {ch.phone_number ? ` (${ch.phone_number})` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Scheduling — optional. Empty means "send now". */}
      <div>
        <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-foreground">
          <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
          Agendar envio{' '}
          <span className="font-normal text-muted-foreground">(opcional)</span>
        </label>
        <div className="flex items-center gap-2">
          <input
            type="datetime-local"
            value={scheduledLocal}
            min={nowLocalInput()}
            onChange={(e) => onScheduledAtChange(localInputToIso(e.target.value))}
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          {isScheduled && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onScheduledAtChange('')}
              disabled={isProcessing}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Limpar
            </Button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {isScheduled
            ? `Será enviado em ${scheduledLabel}.`
            : 'Deixe em branco para enviar agora.'}
        </p>
      </div>

      {/* Summary Card */}
      <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
        <p className="text-sm font-medium text-foreground">Resumo</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Template</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Público</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Alcance estimado</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">
                    {estimatedReach.toLocaleString('pt-BR')}
                  </p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">
              {isScheduled ? 'Agendado para' : 'Envio'}
            </p>
            <p className="text-foreground">
              {isScheduled ? scheduledLabel : 'Imediato'}
            </p>
          </div>
        </div>
      </div>

      {noChannel && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-500">
          Nenhum canal Meta (WhatsApp) configurado. Conecte um canal Meta nas
          configurações antes de enviar um broadcast.
        </div>
      )}

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">
                {isScheduled ? 'Agendando broadcast...' : 'Enfileirando broadcast...'}
              </p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Voltar
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              Salvar rascunho
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
            <DialogTrigger
              render={
                <Button
                  disabled={!name.trim() || isProcessing || noChannel}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                />
              }
            >
              <Send className="h-4 w-4" />
              {isScheduled ? 'Agendar envio' : 'Enviar broadcast'}
            </DialogTrigger>
            <DialogContent className="border-border bg-popover sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">
                  {isScheduled ? 'Confirmar agendamento' : 'Confirmar broadcast'}
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  {isScheduled ? (
                    <>
                      Este broadcast será enviado para{' '}
                      <span className="font-medium text-popover-foreground">
                        {estimatedReach.toLocaleString('pt-BR')}
                      </span>{' '}
                      contatos em{' '}
                      <span className="font-medium text-popover-foreground">
                        {scheduledLabel}
                      </span>{' '}
                      usando o template{' '}
                      <span className="font-medium text-popover-foreground">
                        {template.name}
                      </span>
                      .
                    </>
                  ) : (
                    <>
                      Você está prestes a enviar este broadcast para{' '}
                      <span className="font-medium text-popover-foreground">
                        {estimatedReach.toLocaleString('pt-BR')}
                      </span>{' '}
                      contatos usando o template{' '}
                      <span className="font-medium text-popover-foreground">
                        {template.name}
                      </span>
                      . Esta ação não pode ser desfeita.
                    </>
                  )}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowConfirm(false)}
                  className="border-border text-muted-foreground"
                >
                  Cancelar
                </Button>
                <Button
                  onClick={() => {
                    setShowConfirm(false);
                    onSend();
                  }}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <Send className="h-4 w-4" />
                  {isScheduled ? 'Confirmar agendamento' : 'Confirmar e enviar'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
