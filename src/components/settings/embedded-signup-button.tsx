'use client';

// ============================================================
// EmbeddedSignupButton — one-click "Connect official WhatsApp" via Meta
// Embedded Signup (Tech Provider model).
//
// Loads the Facebook JS SDK, runs FB.login with our ES config, captures the
// `phone_number_id` + `waba_id` from the ES session-info `message` event, and
// POSTs the returned `code` to /api/whatsapp/embedded-signup (which exchanges
// it for a token, subscribes our app to the client's WABA, and creates the
// channel). The client never touches developers.facebook.com — they just log
// into their own Facebook and add their own card in the flow.
//
// Config via public env: NEXT_PUBLIC_META_APP_ID + NEXT_PUBLIC_META_ES_CONFIG_ID.
// The button hides itself until both are set, so the manual editor stays the
// only path on instances that haven't wired Embedded Signup yet.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, MessageCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';

// app_id + ES config id are PUBLIC (they show in the browser/URL), so we ship
// the Fluxia app's values as defaults — `NEXT_PUBLIC_*` are inlined at BUILD
// time (in CI), not at Coolify runtime, so a runtime env var wouldn't reach
// the browser anyway. Override at build time if you fork onto another app.
const APP_ID = process.env.NEXT_PUBLIC_META_APP_ID || '1920154046039310';
const CONFIG_ID =
  process.env.NEXT_PUBLIC_META_ES_CONFIG_ID || '968765662879149';
const GRAPH_VERSION = 'v21.0';

// Minimal shape of the bits of the FB SDK we call.
interface FbSdk {
  init(opts: Record<string, unknown>): void;
  login(
    cb: (resp: { authResponse?: { code?: string }; status?: string }) => void,
    opts: Record<string, unknown>,
  ): void;
}

declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

function loadFbSdk(): Promise<FbSdk> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('no window'));
    if (window.FB) return resolve(window.FB);
    if (!APP_ID) return reject(new Error('NEXT_PUBLIC_META_APP_ID não configurado'));
    window.fbAsyncInit = () => {
      window.FB!.init({
        appId: APP_ID,
        autoLogAppEvents: true,
        xfbml: false,
        version: GRAPH_VERSION,
      });
      resolve(window.FB!);
    };
    // The <script> only needs to be injected once; fbAsyncInit fires on load.
    if (document.getElementById('facebook-jssdk')) return;
    const s = document.createElement('script');
    s.id = 'facebook-jssdk';
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.defer = true;
    s.crossOrigin = 'anonymous';
    s.onerror = () => reject(new Error('Falha ao carregar o SDK do Facebook'));
    document.body.appendChild(s);
  });
}

export function EmbeddedSignupButton({
  onConnected,
}: {
  /** Called after a successful connect — parent should close + refresh. */
  onConnected: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // The ES session-info message arrives on `window` independently of the
  // FB.login callback, so stash the ids here for the callback to read.
  const sessionRef = useRef<{ phone_number_id?: string; waba_id?: string }>({});

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (typeof event.origin !== 'string' || !event.origin.endsWith('facebook.com')) {
        return;
      }
      let data: { type?: string; event?: string; data?: Record<string, string> };
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (data?.type === 'WA_EMBEDDED_SIGNUP' && data.data) {
        sessionRef.current = {
          phone_number_id: data.data.phone_number_id,
          waba_id: data.data.waba_id,
        };
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const start = useCallback(async () => {
    if (!APP_ID || !CONFIG_ID) {
      toast.error(
        'Embedded Signup não configurado (faltam NEXT_PUBLIC_META_APP_ID / NEXT_PUBLIC_META_ES_CONFIG_ID).',
      );
      return;
    }
    setBusy(true);
    sessionRef.current = {};
    try {
      const FB = await loadFbSdk();
      FB.login(
        (response) => {
          const code = response?.authResponse?.code;
          if (!code) {
            setBusy(false);
            toast.error('Conexão cancelada.');
            return;
          }
          const { phone_number_id, waba_id } = sessionRef.current;
          void (async () => {
            try {
              const res = await fetch('/api/whatsapp/embedded-signup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code, phone_number_id, waba_id }),
              });
              const payload = (await res.json().catch(() => ({}))) as {
                error?: string;
              };
              if (!res.ok) {
                toast.error(payload.error || 'Falha ao conectar o WhatsApp oficial.');
                return;
              }
              toast.success('WhatsApp oficial conectado!');
              onConnected();
            } catch {
              toast.error('Falha ao conectar o WhatsApp oficial.');
            } finally {
              setBusy(false);
            }
          })();
        },
        {
          config_id: CONFIG_ID,
          response_type: 'code',
          override_default_response_type: true,
          extras: { setup: {}, sessionInfoVersion: '3' },
        },
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao iniciar a conexão.');
      setBusy(false);
    }
  }, [onConnected]);

  // Hidden until the instance wires Embedded Signup — keeps the manual editor
  // as the sole Meta path otherwise (no dead button).
  if (!APP_ID || !CONFIG_ID) return null;

  return (
    <Button
      onClick={start}
      disabled={busy}
      className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
    >
      {busy ? (
        <>
          <Loader2 className="size-4 animate-spin" />
          Conectando…
        </>
      ) : (
        <>
          <MessageCircle className="size-4" />
          Conectar automaticamente
        </>
      )}
    </Button>
  );
}
