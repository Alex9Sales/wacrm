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
import { AlertTriangle } from 'lucide-react';

import { useServerEvents } from '@/hooks/use-server-events';
import { useCan } from '@/hooks/use-can';
import { ChannelQrModal } from '@/components/settings/channel-qr-modal';
import type { ChannelSummary } from '@/components/settings/channels-tab';
import { CAPABILITIES } from '@/lib/channels/provider';

/** A channel whose session isn't `connected` won't send/receive. */
function isDown(status: string): boolean {
  return status !== 'connected';
}

/** Short reason line per non-connected state (curto, cabe numa linha). */
function reasonFor(status: string): string {
  switch (status) {
    case 'error':
      return 'sessão caiu (possível ban ou logout no aparelho)';
    case 'qr_pending':
      return 'aguardando a leitura do QR';
    case 'disconnected':
    default:
      return 'sessão desconectou';
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
      <div className="border-b border-red-500/15 bg-red-500/[0.06]">
        <div className="mx-auto flex flex-col gap-0.5 px-4 py-1.5 sm:px-6">
          {down.map((ch) => (
            <div
              key={ch.id}
              className="flex items-center gap-1.5 text-xs text-red-700 dark:text-red-300/90"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500/80" />
              <span className="min-w-0 truncate">
                Canal <b className="font-semibold">{ch.name}</b> fora do ar —{' '}
                {reasonFor(ch.status)}.
              </span>
              {canReconnect ? (
                <button
                  type="button"
                  onClick={() => setReconnecting(ch)}
                  className="shrink-0 font-medium underline decoration-red-400/50 underline-offset-2 transition-colors hover:text-red-800 hover:decoration-red-500 dark:hover:text-red-200"
                >
                  Reconectar
                </button>
              ) : (
                <span className="shrink-0 text-red-600/70 dark:text-red-300/60">
                  avise um admin
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
