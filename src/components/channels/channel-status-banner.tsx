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
//
// 15/09 (GoLink): Gmail com a senha de app recusada também aparece — o canal
// fica 'connected' no banco, então o sinal é o `problem` da saúde. O link
// leva pra Canais (onde se troca a senha) só pra owner/admin, que são quem
// consegue abrir as rotas de canal.
//
// 01/10: canais de TOKEN (Instagram, Messenger, WhatsApp oficial) também
// aparecem. Às 15:30 a Meta invalidou o token do Instagram de um cliente (erro
// 190); o monitor marcou o canal, mas este banner só olhava QR e Gmail, e o
// atendente só via "erro de envio" na bolha. Agora: "<canal> desconectado pela
// Meta — <motivo>." Admin (manage-channels, o mesmo papel que a rota de OAuth
// exige) reconecta o Instagram direto pelo OAuth — o callback atualiza o MESMO
// canal pelo ig_id, mantendo o histórico; Messenger/WhatsApp oficial vão para
// Canais. Quem não é admin lê "avise um admin".
//
// Os monitores da Meta rodam no worker e nem todo caminho publica
// `channel_status`: além do evento, o banner relê quando a aba volta a ficar
// visível e a cada 5 min com ela aberta — senão um canal que caiu com a aba já
// aberta só apareceria no F5.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';

import { useServerEvents } from '@/hooks/use-server-events';
import { useCan } from '@/hooks/use-can';
import { ChannelQrModal } from '@/components/settings/channel-qr-modal';
import type { ChannelSummary } from '@/components/settings/channels-tab';
import {
  selectBannerChannels,
  tokenBannerLabel,
  type TokenProviderId,
} from '@/lib/channels/channel-down';

/** Releitura de segurança enquanto a aba está visível (ver cabeçalho). */
const REFRESH_EVERY_MS = 5 * 60_000;
/** Voltar pra aba não relê mais que isto (alt-tab em sequência). */
const MIN_REFETCH_GAP_MS = 30_000;

/** Link de reconexão direto — só o Instagram tem OAuth que atualiza o mesmo canal. */
function reconnectHref(provider: TokenProviderId): string | null {
  return provider === 'instagram' ? '/api/instagram/oauth/start' : null;
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

type StatusChannel = ChannelSummary & { problem?: string | null };

export function ChannelStatusBanner() {
  const canReconnect = useCan('edit-settings');
  const canManageChannels = useCan('manage-channels');
  const [down, setDown] = useState<ChannelSummary[]>([]);
  const [broken, setBroken] = useState<StatusChannel[]>([]);
  const [tokenDown, setTokenDown] = useState<StatusChannel[]>([]);
  const [reconnecting, setReconnecting] = useState<ChannelSummary | null>(null);
  const lastLoadAt = useRef(0);

  // `reconcile=false` (releitura automática): a rota só lê, sem conciliar
  // com o gateway — ver /api/channels/status.
  const load = useCallback(async (reconcile = true) => {
    lastLoadAt.current = Date.now();
    try {
      const res = await fetch(reconcile ? '/api/channels/status' : '/api/channels/status?reconcile=0', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { channels: StatusChannel[] };
      // Três grupos, sem sobreposição (ver selectBannerChannels): QR caído
      // (o "Reconectar" abre o modal de QR — só esses pareiam por QR; um
      // canal de token ali estouraria "does not support QR pairing"), Gmail
      // com problema de saúde, e canal de token que a Meta derrubou.
      const sel = selectBannerChannels(data.channels);
      setDown(sel.qrDown);
      setBroken(sel.gmailBroken);
      setTokenDown(sel.tokenDown);
    } catch {
      // Best-effort — a failed poll just leaves the last known state.
    }
  }, []);

  useEffect(() => {
    // Busca inicial: o setState só acontece depois do fetch (assíncrono), não
    // em cascata no render — o lint não enxerga através do await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Rede de segurança para quem não publica `channel_status` (monitores da
  // Meta no worker): relê ao voltar pra aba e, com ela visível, a cada 5 min.
  // Aba escondida não consulta nada.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastLoadAt.current < MIN_REFETCH_GAP_MS) return;
      void load(false);
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(false);
    }, REFRESH_EVERY_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  // Live: refetch whenever any channel's session state changes.
  const onEvent = useCallback(
    (evt: { type: string }) => {
      if (evt.type === 'channel_status') void load();
    },
    [load],
  );
  useServerEvents(onEvent);

  if (down.length === 0 && broken.length === 0 && tokenDown.length === 0) return null;

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
          {broken.map((ch) => (
            <div
              key={ch.id}
              className="flex items-center gap-1.5 text-xs text-red-700 dark:text-red-300/90"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500/80" />
              <span className="min-w-0 truncate">
                Gmail <b className="font-semibold">{ch.name}</b> parado — {ch.problem}
              </span>
              {canManageChannels ? (
                <Link
                  href="/settings?tab=channels"
                  className="shrink-0 font-medium underline decoration-red-400/50 underline-offset-2 transition-colors hover:text-red-800 hover:decoration-red-500 dark:hover:text-red-200"
                >
                  Abrir Canais
                </Link>
              ) : (
                <span className="shrink-0 text-red-600/70 dark:text-red-300/60">
                  avise um admin
                </span>
              )}
            </div>
          ))}
          {tokenDown.map((ch) => {
            const provider = ch.provider as TokenProviderId;
            const label = tokenBannerLabel(provider, ch.name);
            const href = reconnectHref(provider);
            return (
              <div
                key={ch.id}
                className="flex items-center gap-1.5 text-xs text-red-700 dark:text-red-300/90"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500/80" />
                <span
                  className="min-w-0 truncate"
                  // O motivo é longo e a linha trunca no celular: o texto
                  // inteiro fica no hover.
                  title={`${label ? `${label} ` : ''}${ch.name} desconectado pela Meta — ${ch.problem}.`}
                >
                  {label ? `${label} ` : ''}
                  <b className="font-semibold">{ch.name}</b> desconectado pela Meta —{' '}
                  {ch.problem}.
                </span>
                {canManageChannels ? (
                  href ? (
                    // <a> e não <Link>: é uma rota de API que redireciona pro
                    // login do Instagram — navegação de página inteira.
                    <a
                      href={href}
                      className="shrink-0 font-medium underline decoration-red-400/50 underline-offset-2 transition-colors hover:text-red-800 hover:decoration-red-500 dark:hover:text-red-200"
                    >
                      Reconectar
                    </a>
                  ) : (
                    <Link
                      href="/settings?tab=channels"
                      className="shrink-0 font-medium underline decoration-red-400/50 underline-offset-2 transition-colors hover:text-red-800 hover:decoration-red-500 dark:hover:text-red-200"
                    >
                      Abrir Canais
                    </Link>
                  )
                ) : (
                  <span className="shrink-0 text-red-600/70 dark:text-red-300/60">
                    avise um admin
                  </span>
                )}
              </div>
            );
          })}
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
