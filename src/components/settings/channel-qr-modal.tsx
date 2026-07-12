'use client';

// ============================================================
// ChannelQrModal — QR pairing for non-official providers.
//
// On open: POST /api/channels/[id]/connect → { qr, qrIsImage }.
//   - qrIsImage=true  → `qr` is a data:image/png, rendered directly.
//   - qrIsImage=false → `qr` is a raw QR string ('2@...'); encoded to a
//     data URL client-side with the `qrcode` package.
// While open, polls GET /api/channels/[id]/state every 2s. When status
// flips to 'connected' → toast + onConnected() (parent closes + refreshes).
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import QRCode from 'qrcode';
import { CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { PROVIDER_LABELS, type ChannelSummary } from './channels-tab';

const POLL_MS = 2000;

interface ChannelQrModalProps {
  channel: ChannelSummary;
  onClose: () => void;
  onConnected: () => void;
}

// 'connecting' — /connect returned no QR because the session still has valid
// credentials and is re-establishing on its own (NOWEB auto-reconnect); no
// scan needed. 'connected' — a brief success beat before the modal closes,
// so a reconnect never just silently vanishes.
type Phase = 'loading' | 'ready' | 'connecting' | 'connected' | 'error';

export function ChannelQrModal({
  channel,
  onClose,
  onConnected,
}: ChannelQrModalProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Guards so the polling loop and the connect request don't fire after
  // the modal has been torn down.
  const closedRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  });

  // Turn the connect response into a renderable data URL. A PNG data URL
  // is used as-is; a raw QR string is encoded client-side.
  const resolveQr = useCallback(
    async (qr: string, qrIsImage: boolean): Promise<string> => {
      if (qrIsImage) return qr;
      return QRCode.toDataURL(qr, { margin: 1, width: 260 });
    },
    [],
  );

  const requestQr = useCallback(async () => {
    setPhase('loading');
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/channels/${channel.id}/connect`, {
        method: 'POST',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { qr: string; qrIsImage: boolean };
      if (closedRef.current) return;
      if (!data.qr) {
        // No QR means the session isn't asking to pair — its credentials are
        // still valid and it's reconnecting on its own. Not an error; the
        // state poll will confirm 'connected' shortly.
        setPhase('connecting');
        return;
      }
      const dataUrl = await resolveQr(data.qr, !!data.qrIsImage);
      if (closedRef.current) return;
      setQrDataUrl(dataUrl);
      setPhase('ready');
    } catch (err) {
      if (closedRef.current) return;
      console.error('[channels] connect failed:', err);
      setErrorMsg(
        err instanceof Error ? err.message : 'Falha ao gerar o QR Code.',
      );
      setPhase('error');
    }
  }, [channel.id, resolveQr]);

  // Poll the channel state on an interval. Self-reschedules so a slow
  // response never overlaps the next tick.
  const poll = useCallback(async () => {
    if (closedRef.current) return;
    try {
      const res = await fetch(`/api/channels/${channel.id}/state`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const { status } = (await res.json()) as { status: string };
        if (closedRef.current) return;
        if (status === 'connected') {
          toast.success(`Canal "${channel.name}" conectado.`);
          // Show a brief success beat so a reconnect never just vanishes,
          // then hand back to the parent (which closes + refreshes).
          setPhase('connected');
          connectedTimerRef.current = setTimeout(() => {
            if (!closedRef.current) onConnectedRef.current();
          }, 1200);
          return;
        }
        if (status === 'error') {
          setErrorMsg('O provedor reportou um erro na conexão.');
          setPhase('error');
          return;
        }
      }
    } catch {
      // Transient network error — keep polling.
    }
    if (!closedRef.current) {
      pollTimerRef.current = setTimeout(() => void poll(), POLL_MS);
    }
  }, [channel.id, channel.name]);

  // Kick off the connect + polling once, on mount.
  useEffect(() => {
    closedRef.current = false;
    void requestQr();
    pollTimerRef.current = setTimeout(() => void poll(), POLL_MS);
    return () => {
      closedRef.current = true;
      if (pollTimerRef.current !== null) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (connectedTimerRef.current !== null) {
        clearTimeout(connectedTimerRef.current);
        connectedTimerRef.current = null;
      }
    };
    // Mount-once: requestQr/poll are stable for a given channel id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) onClose();
    },
    [onClose],
  );

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            Parear {channel.name}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Abra o WhatsApp no celular, vá em{' '}
            <span className="font-medium text-foreground">
              Aparelhos conectados
            </span>{' '}
            e escaneie o código abaixo. ({PROVIDER_LABELS[channel.provider]})
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 py-2">
          {phase === 'loading' && (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="size-6 animate-spin" />
              <p className="text-sm">Gerando QR Code...</p>
            </div>
          )}

          {phase === 'ready' && qrDataUrl && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrDataUrl}
                alt="QR Code de pareamento"
                className="size-[260px] rounded-lg bg-white p-2"
              />
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Aguardando leitura...
              </div>
            </>
          )}

          {phase === 'connecting' && (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="size-6 animate-spin" />
              <p className="text-sm">Reconectando a sessão...</p>
              <p className="max-w-[16rem] text-center text-xs text-muted-foreground/80">
                Este número ainda está logado — não precisa ler QR. Aguarde a
                reconexão.
              </p>
            </div>
          )}

          {phase === 'connected' && (
            <div className="flex flex-col items-center gap-2 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-8" />
              <p className="text-sm font-medium">Canal conectado!</p>
            </div>
          )}

          {phase === 'error' && (
            <div className="flex flex-col items-center gap-3 text-center">
              <XCircle className="size-8 text-red-400" />
              <p className="text-sm text-muted-foreground">
                {errorMsg ?? 'Não foi possível gerar o QR Code.'}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void requestQr()}
                className="border-border"
              >
                <RefreshCw className="size-3.5" />
                Tentar novamente
              </Button>
            </div>
          )}
        </div>

        <DialogFooter className="border-border bg-popover">
          <Button
            variant="outline"
            onClick={onClose}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
