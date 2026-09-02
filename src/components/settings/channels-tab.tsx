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
  MapPin,
  Users,
  MessageCircle,
  Globe,
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
import { EmailDomainDialog, type DomainState } from './email-domain-dialog';
import { EmailApiSetupDialog, type EmailApiInbound } from './email-api-setup-dialog';
import { ChannelQrModal } from './channel-qr-modal';
import { ChannelLocationDialog } from './channel-location-dialog';
import { ChannelPixDialog } from './channel-pix-dialog';
import { ChannelGroupsDialog } from './channel-groups-dialog';
import { ChannelCommentAutomationDialog } from './channel-comment-automation-dialog';
import { ChannelProviderIcon } from './channel-provider-icon';

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
  instagram: 'Instagram Direct',
  messenger: 'Messenger',
  email: 'E-mail',
  gmail: 'Gmail',
  waha: 'WAHA',
  evolution: 'Evolution',
  evogo: 'EvoGo',
};

function fmtHealthTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

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
  // E-mail com domínio próprio em setup (registros DNS + encaminhamento).
  const [domainSetup, setDomainSetup] = useState<
    { channelId: string; initial: DomainState | null } | null
  >(null);
  // E-mail BYO (meu provedor/API) recém-criado → mostra webhook + segredo.
  const [apiInbound, setApiInbound] = useState<EmailApiInbound | null>(null);
  // The channel whose business location is being set.
  const [locating, setLocating] = useState<ChannelSummary | null>(null);
  // The channel whose Pix key is being set.
  const [pixing, setPixing] = useState<ChannelSummary | null>(null);
  // The channel whose monitored groups are being picked.
  const [grouping, setGrouping] = useState<ChannelSummary | null>(null);
  // O canal Instagram cuja automação de comentários está sendo editada.
  const [commenting, setCommenting] = useState<ChannelSummary | null>(null);
  // The channel pending delete-confirmation.
  const [deleting, setDeleting] = useState<ChannelSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // When the first delete attempt is blocked (409, channel has
  // conversations), we surface a second confirm dialog carrying the count.
  // Non-null while that force-confirm is open.
  const [forceDelete, setForceDelete] = useState<{
    channel: ChannelSummary;
    conversationCount: number;
  } | null>(null);

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

  // Resultado dos retornos OAuth (IG/Messenger) — o callback redireciona pra
  // cá com ?ig= / ?messenger=. O caso que importa avisar é o limite do plano
  // (senão o canal simplesmente "não aparece" e vira chamado de suporte).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('ig') ?? params.get('messenger');
    if (!status) return;
    if (status === 'limite_plano') {
      toast.error(
        'Seu plano chegou ao limite de canais. Faça upgrade em Configurações → Assinatura para conectar mais.',
        { duration: 10000 },
      );
    } else if (status === 'erro') {
      toast.error('Não foi possível concluir a conexão. Tente de novo.');
    }
    // Limpa os params pra não re-tostar em cada remontagem.
    params.delete('ig');
    params.delete('messenger');
    const rest = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${rest ? `?${rest}` : ''}`,
    );
  }, []);

  // Delete a channel. `force` retries past the 409 the API raises when the
  // channel still owns conversations (cascade-deleting them). The delete is
  // independent of the channel's session state, so an errored/dropped
  // channel deletes the same way.
  const deleteChannel = useCallback(
    async (channel: ChannelSummary, force: boolean) => {
      setDeleteBusy(true);
      try {
        const res = await fetch(
          `/api/channels/${channel.id}${force ? '?force=true' : ''}`,
          { method: 'DELETE' },
        );
        if (res.status === 409 && !force) {
          // Channel has conversations — surface the count and ask the
          // operator to confirm the cascade instead of failing outright.
          const payload = (await res.json().catch(() => ({}))) as {
            conversationCount?: number;
          };
          setDeleting(null);
          setForceDelete({
            channel,
            conversationCount: payload.conversationCount ?? 0,
          });
          return;
        }
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          toast.error(payload.error || 'Falha ao remover o canal.');
          return;
        }
        toast.success('Canal removido.');
        setDeleting(null);
        setForceDelete(null);
        void load();
      } catch (err) {
        console.error('[channels] delete failed:', err);
        toast.error('Não foi possível remover o canal.');
      } finally {
        setDeleteBusy(false);
      }
    },
    [load],
  );

  const handleDelete = useCallback(() => {
    if (!deleting) return;
    void deleteChannel(deleting, false);
  }, [deleting, deleteChannel]);

  const handleForceDelete = useCallback(() => {
    if (!forceDelete) return;
    void deleteChannel(forceDelete.channel, true);
  }, [forceDelete, deleteChannel]);

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
              onLocation={() => setLocating(ch)}
              onPix={() => setPixing(ch)}
              onGroups={() => setGrouping(ch)}
              onComments={() => setCommenting(ch)}
              onDelete={() => setDeleting(ch)}
              onConfigureDomain={() => setDomainSetup({ channelId: ch.id, initial: null })}
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
          // Só os provedores com pareamento por QR (WAHA/Evolution/EvoGo) abrem
          // o modal de QR ao criar. Meta e Instagram conectam por token — nada
          // de QR.
          if (created && CAPABILITIES[created.provider]?.qrPairing) {
            setPairing(created);
          }
        }}
        onPickMeta={() => {
          setAddOpen(false);
          setView({ kind: 'meta', channelId: null });
        }}
        onBrandedCreated={({ channelId, initial }) => {
          setAddOpen(false);
          void load();
          setDomainSetup({ channelId, initial });
        }}
        onEmailApiCreated={(inbound) => {
          setAddOpen(false);
          void load();
          setApiInbound(inbound);
        }}
      />

      {/* Setup do domínio próprio (white-label): registros DNS + encaminhamento. */}
      <EmailDomainDialog
        channelId={domainSetup?.channelId ?? null}
        initial={domainSetup?.initial ?? null}
        onClose={() => setDomainSetup(null)}
        onVerified={() => void load()}
      />

      {/* E-mail BYO recém-criado: webhook + segredo pra o cliente ligar o inbound. */}
      <EmailApiSetupDialog inbound={apiInbound} onClose={() => setApiInbound(null)} />

      {/* Business location editor for a channel. */}
      {locating && (
        <ChannelLocationDialog
          channel={locating}
          onClose={() => setLocating(null)}
          onSaved={() => {
            setLocating(null);
            void load();
          }}
        />
      )}

      {/* Pix key editor for a channel. */}
      {pixing && (
        <ChannelPixDialog
          channel={pixing}
          onClose={() => setPixing(null)}
          onSaved={() => {
            setPixing(null);
            void load();
          }}
        />
      )}

      {/* Group-monitoring picker for a channel. */}
      {grouping && (
        <ChannelGroupsDialog
          channel={grouping}
          onClose={() => setGrouping(null)}
        />
      )}

      {/* Automação comentário→DM (só Instagram). */}
      {commenting && (
        <ChannelCommentAutomationDialog
          channel={commenting}
          onClose={() => setCommenting(null)}
        />
      )}

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

      {/* Force-delete confirmation — shown when the first delete attempt was
          blocked because the channel still has conversations. Confirming
          cascade-deletes those conversations and their history. */}
      <Dialog
        open={!!forceDelete}
        onOpenChange={(next) => {
          if (!next && !deleteBusy) setForceDelete(null);
        }}
      >
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              Remover canal e conversas
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Este canal tem{' '}
              <span className="font-medium text-foreground">
                {forceDelete?.conversationCount ?? 0} conversa(s)
              </span>
              . Excluir o canal também apaga essas conversas e o histórico.
              Deseja continuar?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="border-border bg-popover">
            <Button
              variant="outline"
              onClick={() => setForceDelete(null)}
              disabled={deleteBusy}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleForceDelete}
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
                  Excluir tudo
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
  onLocation,
  onPix,
  onGroups,
  onComments,
  onDelete,
  onConfigureDomain,
}: {
  channel: ChannelSummary;
  onEditMeta: () => void;
  onPair: () => void;
  onLocation: () => void;
  onPix: () => void;
  onGroups: () => void;
  onComments: () => void;
  onDelete: () => void;
  onConfigureDomain: () => void;
}) {
  const isMeta = channel.provider === 'meta';
  const metaHealth = (channel.provider_meta as { health?: { last_error?: string | null; last_at?: string | null; warning?: string | null } }).health ?? null;
  const isInstagram = channel.provider === 'instagram';
  const canPair = CAPABILITIES[channel.provider]?.qrPairing ?? false;
  const isBrandedEmail =
    channel.provider === 'email' &&
    (channel.provider_meta as { mode?: string }).mode === 'branded';
  const pairLabel =
    channel.status === 'connected' ? 'Reparear' : 'Parear';
  const hasLocation = !!(channel.provider_meta as { location?: unknown })
    .location;
  const hasPix = !!(channel.provider_meta as { pix?: unknown }).pix;

  return (
    <Card size="sm">
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ChannelProviderIcon provider={channel.provider} className="h-9 w-9" />
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
            {/* 🩺 Saúde real na Meta (monitor a cada 30 min). */}
            {isMeta && metaHealth?.last_error && channel.status !== 'connected' && (
              <p className="mt-0.5 text-[11px] text-red-500" title={metaHealth.last_error}>
                Meta: {metaHealth.last_error}
                {metaHealth.last_at ? ` · verificado ${fmtHealthTime(metaHealth.last_at)}` : ''}
                {' · reconecte pelo botão Meta em Canais'}
              </p>
            )}
            {isMeta && !metaHealth?.last_error && metaHealth?.warning && (
              <p className="mt-0.5 text-[11px] text-amber-500" title={metaHealth.warning}>
                Meta: {metaHealth.warning}
              </p>
            )}
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

          {isBrandedEmail && (
            <Button
              variant="outline"
              size="sm"
              onClick={onConfigureDomain}
              className="border-border"
              title="Registros DNS + encaminhamento do domínio próprio"
            >
              <Globe className="size-3.5" />
              {channel.status === 'connected' ? 'Domínio' : 'Configurar domínio'}
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            title={
              hasLocation
                ? 'Localização cadastrada — editar'
                : 'Cadastrar localização'
            }
            onClick={onLocation}
            className={
              hasLocation
                ? 'text-emerald-600 hover:text-emerald-700'
                : 'text-muted-foreground hover:text-foreground'
            }
          >
            <MapPin className="size-3.5" />
            Localização
          </Button>

          <Button
            variant="ghost"
            size="sm"
            title={hasPix ? 'Chave Pix cadastrada — editar' : 'Cadastrar chave Pix'}
            onClick={onPix}
            className={
              hasPix
                ? 'text-emerald-600 hover:text-emerald-700'
                : 'text-muted-foreground hover:text-foreground'
            }
          >
            Pix
          </Button>

          {channel.provider === 'waha' && (
            <Button
              variant="ghost"
              size="sm"
              title="Grupos monitorados"
              onClick={onGroups}
              className="text-muted-foreground hover:text-foreground"
            >
              <Users className="size-3.5" />
              Grupos
            </Button>
          )}

          {isInstagram && (
            <Button
              variant="ghost"
              size="sm"
              title="Automação de comentários (comentário → DM)"
              onClick={onComments}
              className="text-muted-foreground hover:text-foreground"
            >
              <MessageCircle className="size-3.5" />
              Comentários
            </Button>
          )}

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
