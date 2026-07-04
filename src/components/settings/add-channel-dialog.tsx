'use client';

// ============================================================
// AddChannelDialog — provider picker + provider-specific form.
//
// Step 1: pick a provider (Meta | WAHA | Evolution | EvoGo).
//   - Meta hands off to the full <WhatsAppConfig /> editor via
//     `onPickMeta` (its registration/PIN flow lives there).
//   - The three non-official providers show their own field set and
//     POST /api/channels { provider, name, config }.
// Returns the created channel to the parent so it can immediately open
// the QR pairing modal.
// ============================================================

import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import type { ProviderId } from '@/lib/channels/provider';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { PROVIDER_LABELS, type ChannelSummary } from './channels-tab';

interface AddChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create (non-Meta). Carries the new row so
   *  the parent can open the QR modal. */
  onCreated: (created: ChannelSummary | null) => void;
  /** Meta was picked — the parent swaps to the WhatsAppConfig editor. */
  onPickMeta: () => void;
}

const PROVIDER_ORDER: ProviderId[] = ['meta', 'waha', 'evolution', 'evogo'];

const PROVIDER_BLURB: Record<ProviderId, string> = {
  meta: 'API oficial do WhatsApp. Suporta templates e mensagens interativas.',
  waha: 'Provedor não oficial (WAHA). Pareamento por QR Code.',
  evolution: 'Provedor não oficial (Evolution API). Pareamento por QR Code.',
  evogo: 'Provedor não oficial (EvoGo). Pareamento por QR Code.',
};

/** Per-provider config fields (non-Meta). `secret` masks the input. */
interface FieldDef {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  optional?: boolean;
}

const PROVIDER_FIELDS: Record<
  Exclude<ProviderId, 'meta'>,
  FieldDef[]
> = {
  waha: [
    { key: 'base_url', label: 'URL base', placeholder: 'https://waha.seudominio.com' },
    { key: 'api_key', label: 'API Key', placeholder: 'Sua X-Api-Key', secret: true },
    { key: 'session', label: 'Sessão', placeholder: 'default' },
  ],
  evolution: [
    { key: 'base_url', label: 'URL base', placeholder: 'https://evolution.seudominio.com' },
    { key: 'api_key', label: 'API Key', placeholder: 'Sua apikey', secret: true },
    { key: 'instance', label: 'Instância', placeholder: 'nome-da-instancia' },
  ],
  evogo: [
    { key: 'base_url', label: 'URL base', placeholder: 'https://evogo.seudominio.com' },
    { key: 'token', label: 'Token', placeholder: 'Seu token', secret: true },
  ],
};

export function AddChannelDialog({
  open,
  onOpenChange,
  onCreated,
  onPickMeta,
}: AddChannelDialogProps) {
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [name, setName] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const fields = useMemo(
    () =>
      provider && provider !== 'meta'
        ? PROVIDER_FIELDS[provider as Exclude<ProviderId, 'meta'>]
        : [],
    [provider],
  );

  const reset = useCallback(() => {
    setProvider(null);
    setName('');
    setConfig({});
    setSubmitting(false);
  }, []);

  const handleClose = useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const handlePickProvider = useCallback(
    (p: ProviderId) => {
      if (p === 'meta') {
        reset();
        onPickMeta();
        return;
      }
      setProvider(p);
      setConfig({});
    },
    [onPickMeta, reset],
  );

  const handleCreate = useCallback(async () => {
    if (!provider || provider === 'meta') return;
    if (!name.trim()) {
      toast.error('Dê um nome ao canal.');
      return;
    }
    // All non-optional fields are required.
    for (const f of fields) {
      if (!f.optional && !config[f.key]?.trim()) {
        toast.error(`Preencha o campo "${f.label}".`);
        return;
      }
    }

    setSubmitting(true);
    try {
      const cleanConfig: Record<string, string> = {};
      for (const f of fields) {
        const v = config[f.key]?.trim();
        if (v) cleanConfig[f.key] = v;
      }

      const res = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, name: name.trim(), config: cleanConfig }),
      });

      if (res.status === 409) {
        toast.error('Já existe um canal com esse nome. Escolha outro.');
        return;
      }
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao criar o canal.');
        return;
      }

      const { id } = (await res.json()) as { id: string };
      toast.success('Canal criado. Escaneie o QR Code para parear.');
      // Build a lightweight summary so the parent can open the QR modal
      // without waiting for a list refetch.
      onCreated({
        id,
        provider,
        name: name.trim(),
        status: 'disconnected',
        phone_number: null,
        provider_meta: {},
        created_at: new Date().toISOString(),
      });
      reset();
    } catch (err) {
      console.error('[channels] create failed:', err);
      toast.error('Não foi possível criar o canal.');
    } finally {
      setSubmitting(false);
    }
  }, [provider, name, fields, config, onCreated, reset]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            Adicionar canal
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {provider
              ? `Configure as credenciais do ${PROVIDER_LABELS[provider]}.`
              : 'Escolha o provedor do canal de WhatsApp.'}
          </DialogDescription>
        </DialogHeader>

        {!provider ? (
          <div className="grid gap-2 py-2">
            {PROVIDER_ORDER.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => handlePickProvider(p)}
                className="flex flex-col items-start gap-0.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-left transition-colors hover:border-primary/50 hover:bg-muted"
              >
                <span className="text-sm font-medium text-foreground">
                  {PROVIDER_LABELS[p]}
                </span>
                <span className="text-xs text-muted-foreground">
                  {PROVIDER_BLURB[p]}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-muted-foreground">Nome do canal</Label>
              <Input
                placeholder="ex.: Atendimento comercial"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
            </div>
            {fields.map((f) => (
              <div key={f.key} className="space-y-2">
                <Label className="text-muted-foreground">
                  {f.label}
                  {f.optional && (
                    <span className="ml-1 text-xs">(opcional)</span>
                  )}
                </Label>
                <Input
                  type={f.secret ? 'password' : 'text'}
                  placeholder={f.placeholder}
                  value={config[f.key] ?? ''}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, [f.key]: e.target.value }))
                  }
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="border-border bg-popover">
          {provider ? (
            <>
              <Button
                variant="outline"
                onClick={() => setProvider(null)}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                Voltar
              </Button>
              <Button
                onClick={handleCreate}
                disabled={submitting}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Criando...
                  </>
                ) : (
                  'Criar canal'
                )}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() => handleClose(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
