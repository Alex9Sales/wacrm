'use client';

// ============================================================
// Global "channel down — reconnect" banner.
//
// Sits under the header on every dashboard page. It shows whenever a
// WhatsApp channel's session is not `connected` (a ban, a logout, a dropped
// session) — the states where messages silently stop going out. It reacts
// live to the `channel_status` SSE event the webhook publishes, so a drop
// surfaces without a refresh, and clears the moment the session is WORKING
// again.
//
// The "Reconectar" action reuses the same QR-pairing modal as Settings →
// Canais (POST /connect → QR → poll /state). Only admins (edit-settings)
// can re-pair, so agents just see the heads-up.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, QrCode } from 'lucide-react';

import { useServerEvents } from '@/hooks/use-server-events';
import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { ChannelQrModal } from '@/components/settings/channel-qr-modal';
import type { ChannelSummary } from '@/components/settings/channels-tab';
import { CAPABILITIES } from '@/lib/channels/provider';

/** A channel whose session isn't `connected` won't send/receive. */
function isDown(status: string): boolean {
  return status !== 'connected';
}

/** Short reason line per non-connected state. */
function reasonFor(status: string): string {
  switch (status) {
    case 'error':
      return 'a sessão caiu (possível ban ou logout no aparelho)';
    case 'qr_pending':
      return 'aguardando leitura do QR Code';
    case 'disconnected':
    default:
      return 'a sessão desconectou';
  }
}

export function ChannelStatusBanner() {
  const canReconnect = useCan('edit-settings');
  const [down, setDown] = useState<ChannelSummary[]>([]);
  const [reconnecting, setReconnecting] = useState<ChannelSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/channels/status', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { channels: ChannelSummary[] };
      // Só canais de PAREAMENTO POR QR (WAHA/Evolution/EvoGo) têm "sessão que
      // cai" e reconexão por QR. Providers de token (meta/instagram/messenger)
      // não pareiam por QR — nunca mostram este banner (senão o "Reconectar"
      // abre o modal de QR e estoura "does not support QR pairing").
      setDown(
        data.channels.filter(
          (c) => isDown(c.status) && CAPABILITIES[c.provider]?.qrPairing,
        ),
      );
    } catch {
      // Best-effort — a failed poll just leaves the last known state.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live: refetch whenever any channel's session state changes.
  const onEvent = useCallback(
    (evt: { type: string }) => {
      if (evt.type === 'channel_status') void load();
    },
    [load],
  );
  useServerEvents(onEvent);

  if (down.length === 0) return null;

  return (
    <>
      <div className="border-b border-amber-500/30 bg-amber-500/10">
        <div className="mx-auto flex flex-col gap-2 px-4 py-2.5 sm:px-6">
          {down.map((ch) => (
            <div
              key={ch.id}
              className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="text-amber-900 dark:text-amber-200">
                O canal <b>{ch.name}</b> saiu do ar — {reasonFor(ch.status)}. As
                mensagens não estão saindo por ele.
              </span>
              {canReconnect ? (
                <Button
                  size="sm"
                  onClick={() => setReconnecting(ch)}
                  className="ml-auto h-7 gap-1.5 bg-amber-600 text-white hover:bg-amber-700"
                >
                  <QrCode className="h-3.5 w-3.5" />
                  Reconectar
                </Button>
              ) : (
                <span className="ml-auto text-xs text-amber-700/80 dark:text-amber-300/80">
                  Avise um administrador para reconectar.
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {reconnecting && (
        <ChannelQrModal
          channel={reconnecting}
          onClose={() => setReconnecting(null)}
          onConnected={() => {
            setReconnecting(null);
            void load();
          }}
        />
      )}
    </>
  );
}
