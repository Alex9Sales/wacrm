'use client';

// ============================================================
// ChannelsTab — Settings → "Canais" (Phase 4, Wave 4B).
//
// Lists every WhatsApp channel on the account (Meta + WAHA +
// Evolution + EvoGo), lets the operator add one via a provider-picker
// dialog, pair the non-official ones through a QR modal, and delete
// channels. The Meta channel's editor is the pre-existing
// <WhatsAppConfig /> form (folded in via <MetaChannelEditor />) so its
// registration-PIN / webhook UX stays intact.
//
// Talks ONLY to the Wave 4A API contract (/api/channels*). It never
// imports an adapter or a send route.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Plus,
  QrCode,
  Trash2,
  RefreshCw,
  ArrowLeft,
} from 'lucide-react';

import { CAPABILITIES, type ProviderId } from '@/lib/channels/provider';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

import { WhatsAppConfig } from './whatsapp-config';
import { AddChannelDialog } from './add-channel-dialog';
import { ChannelQrModal } from './channel-qr-modal';

// ------------------------------------------------------------
// Shared types + labels (mirrored by the child dialogs).
// ------------------------------------------------------------

export type ChannelStatus =
  | 'connected'
  | 'qr_pending'
  | 'disconnected'
  | 'error';

export interface ChannelSummary {
  id: string;
  provider: ProviderId;
  name: string;
  status: ChannelStatus;
  phone_number: string | null;
  provider_meta: Record<string, unknown>;
  created_at: string;
}

/** Human labels for each provider (pt-BR UI). */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  meta: 'Meta (API Oficial)',
  waha: 'WAHA',
  evolution: 'Evolution',
  evogo: 'EvoGo',
};

const STATUS_META: Record<
  ChannelStatus,
  { label: string; dot: string; badge: string }
> = {
  connected: {
    label: 'Conectado',
    dot: 'bg-emerald-500',
    badge: 'border-emerald-500/40 text-emerald-400',
  },
  qr_pending: {
    label: 'Aguardando pareamento',
    dot: 'bg-amber-500',
    badge: 'border-amber-500/40 text-amber-400',
  },
  disconnected: {
    label: 'Desconectado',
    dot: 'bg-muted-foreground',
    badge: 'border-border text-muted-foreground',
  },
  error: {
    label: 'Erro',
    dot: 'bg-red-500',
    badge: 'border-red-500/40 text-red-400',
  },
};

export function ChannelStatusBadge({ status }: { status: ChannelStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.disconnected;
  return (
    <Badge variant="outline" className={cn('gap-1.5', meta.badge)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} />
      {meta.label}
    </Badge>
  );
}

// ------------------------------------------------------------
// ChannelsTab
// ------------------------------------------------------------

type View =
  | { kind: 'list' }
  | { kind: 'meta'; channelId: string | null }; // editing (id) or adding (null)

export function ChannelsTab() {
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>({ kind: 'list' });

  const [addOpen, setAddOpen] = useState(false);
  // The channel currently being paired via the QR modal (non-Meta only).
  const [pairing, setPairing] = useState<ChannelSummary | null>(null);
  // The channel pending delete-confirmation.
  const [deleting, setDeleting] = useState<ChannelSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/channels', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { channels: ChannelSummary[] };
      setChannels(data.channels ?? []);
    } catch (err) {
      console.error('[channels] load failed:', err);
      toast.error('Não foi possível carregar os canais.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDelete = useCallback(async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/channels/${deleting.id}`, {
        method: 'DELETE',
      });
      if (res.status === 409) {
        toast.error(
          'Este canal tem conversas vinculadas e não pode ser removido. Arquive ou mova as conversas primeiro.',
        );
        return;
      }
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao remover o canal.');
        return;
      }
      toast.success('Canal removido.');
      setDeleting(null);
      void load();
    } catch (err) {
      console.error('[channels] delete failed:', err);
      toast.error('Não foi possível remover o canal.');
    } finally {
      setDeleteBusy(false);
    }
  }, [deleting, load]);

  // --- Meta editor view (folds in the existing WhatsAppConfig form) ---
  if (view.kind === 'meta') {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => {
            setView({ kind: 'list' });
            void load();
          }}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Voltar aos canais
        </button>
        <WhatsAppConfig />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Canais</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Conecte e gerencie os canais de WhatsApp da sua conta — API
            Oficial (Meta) ou provedores não oficiais (WAHA, Evolution,
            EvoGo) via QR Code.
          </p>
        </div>
        <Button
          onClick={() => setAddOpen(true)}
          className="shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="size-4" />
          Adicionar canal
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : channels.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted">
              <QrCode className="size-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">
                Nenhum canal ainda
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Adicione seu primeiro canal para começar a receber e enviar
                mensagens.
              </p>
            </div>
            <Button
              onClick={() => setAddOpen(true)}
              variant="outline"
              className="border-border"
            >
              <Plus className="size-4" />
              Adicionar canal
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {channels.map((ch) => (
            <ChannelRow
              key={ch.id}
              channel={ch}
              onEditMeta={() => setView({ kind: 'meta', channelId: ch.id })}
              onPair={() => setPairing(ch)}
              onDelete={() => setDeleting(ch)}
            />
          ))}
        </div>
      )}

      {/* Add-channel dialog: provider picker + provider-specific fields.
          For Meta it hands off to the full WhatsAppConfig editor. */}
      <AddChannelDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(created) => {
          setAddOpen(false);
          void load();
          // Non-Meta channels need pairing right after creation.
          if (created && created.provider !== 'meta') {
            setPairing(created);
          }
        }}
        onPickMeta={() => {
          setAddOpen(false);
          setView({ kind: 'meta', channelId: null });
        }}
      />

      {/* QR pairing modal — polls state, closes on 'connected'. */}
      {pairing && (
        <ChannelQrModal
          channel={pairing}
          onClose={() => {
            setPairing(null);
            void load();
          }}
          onConnected={() => {
            setPairing(null);
            void load();
          }}
        />
      )}

      {/* Delete confirmation */}
      <Dialog
        open={!!deleting}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
      >
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              Remover canal
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Tem certeza que deseja remover o canal{' '}
              <span className="font-medium text-foreground">
                {deleting?.name}
              </span>
              ? Esta ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="border-border bg-popover">
            <Button
              variant="outline"
              onClick={() => setDeleting(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteBusy}
            >
              {deleteBusy ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Removendo...
                </>
              ) : (
                <>
                  <Trash2 className="size-4" />
                  Remover
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------
// ChannelRow
// ------------------------------------------------------------

function ChannelRow({
  channel,
  onEditMeta,
  onPair,
  onDelete,
}: {
  channel: ChannelSummary;
  onEditMeta: () => void;
  onPair: () => void;
  onDelete: () => void;
}) {
  const isMeta = channel.provider === 'meta';
  const canPair = CAPABILITIES[channel.provider]?.qrPairing ?? false;
  const pairLabel =
    channel.status === 'connected' ? 'Reparear' : 'Parear';

  return (
    <Card size="sm">
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">
                {channel.name}
              </span>
              <Badge variant="secondary" className="shrink-0">
                {PROVIDER_LABELS[channel.provider]}
              </Badge>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {channel.phone_number || 'Número não vinculado'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ChannelStatusBadge status={channel.status} />

          {isMeta ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onEditMeta}
              className="border-border"
            >
              Configurar
            </Button>
          ) : canPair ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onPair}
              className="border-border"
            >
              {channel.status === 'connected' ? (
                <RefreshCw className="size-3.5" />
              ) : (
                <QrCode className="size-3.5" />
              )}
              {pairLabel}
            </Button>
          ) : null}

          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remover canal"
            title="Remover canal"
            onClick={onDelete}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
