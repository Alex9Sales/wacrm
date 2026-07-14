'use client';

// ============================================================
// Call modal for WhatsApp voice calls (Meta Business Calling), both ways:
//  - INBOUND: `call_incoming` SSE carries the caller's SDP offer → ring →
//    Atender → answer (setRemote(offer) → createAnswer → POST accept).
//  - OUTBOUND: a `fluxia:outbound-call` window event (from the conversation
//    header "Ligar" button) → createOffer → POST /api/calls/initiate → the
//    customer's answer arrives via the `call_answer` SSE → setRemote(answer).
// Media (mic/speaker) lives in the browser; the token stays server-side.
// Mounted once, globally, in the dashboard shell.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Phone,
  PhoneOff,
  Mic,
  MicOff,
  ShieldQuestion,
  Minimize2,
  Maximize2,
} from 'lucide-react';

import { useServerEvents } from '@/hooks/use-server-events';
import { formatCallDuration } from '@/lib/inbox/call-log';

type Phase =
  | 'idle'
  | 'ringing' // inbound, waiting for the agent to answer
  | 'dialing' // outbound, setting up / waiting for the customer
  | 'connecting'
  | 'active'
  | 'permission'; // outbound blocked — needs the customer's permission

/** Which calling transport a call runs on. Meta = official Business Calling
 *  (permission + SSE answer); waha = unofficial waha-voip (no permission, the
 *  /webrtc endpoint returns the SDP answer synchronously). */
type CallProvider = 'meta' | 'waha';

interface ActiveCall {
  callId: string;
  peer: string; // customer phone (E.164 digits)
  name?: string;
  provider: CallProvider;
}

/** Fire this to start an outbound call from anywhere in the app. Defaults to
 *  the official Meta transport; pass 'waha' for the unofficial waha-voip one. */
export function startOutboundCall(
  to: string,
  name?: string,
  provider: CallProvider = 'meta',
) {
  window.dispatchEvent(
    new CustomEvent('fluxia:outbound-call', { detail: { to, name, provider } }),
  );
}

function waitIceComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', done);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 2500);
  });
}

export function IncomingCallModal() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [dir, setDir] = useState<'in' | 'out'>('in');
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [muted, setMuted] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const callIdRef = useRef<string>('');
  const offerSdpRef = useRef<string>(''); // inbound offer to answer
  const ringCtxRef = useRef<AudioContext | null>(null);
  const ringTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopRingtone = useCallback(() => {
    if (ringTimerRef.current) {
      clearInterval(ringTimerRef.current);
      ringTimerRef.current = null;
    }
    ringCtxRef.current?.close().catch(() => {});
    ringCtxRef.current = null;
    try {
      navigator.vibrate?.(0); // stop any vibration
    } catch {
      /* not supported */
    }
  }, []);

  const startRingtone = useCallback(() => {
    // Screen/device vibration in the classic ring cadence (mobile only).
    try {
      navigator.vibrate?.([600, 400, 600, 1400]);
    } catch {
      /* not supported */
    }
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctx();
      ringCtxRef.current = ctx;
      // A telephone-style "brrring": a dual-tone (440+480 Hz) burst that
      // pulses twice, then a gap — repeated on a ~3s cadence.
      const ringBurst = () => {
        const t0 = ctx.currentTime;
        for (const [f1, f2] of [[440, 480]] as const) {
          // two short pulses ("brr-brr")
          for (const start of [0, 0.5]) {
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t0 + start);
            g.gain.exponentialRampToValueAtTime(0.12, t0 + start + 0.04);
            g.gain.setValueAtTime(0.12, t0 + start + 0.35);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + 0.42);
            g.connect(ctx.destination);
            for (const f of [f1, f2]) {
              const o = ctx.createOscillator();
              o.type = 'sine';
              o.frequency.value = f;
              o.connect(g);
              o.start(t0 + start);
              o.stop(t0 + start + 0.42);
            }
          }
        }
      };
      ringBurst();
      ringTimerRef.current = setInterval(() => {
        ringBurst();
        try {
          navigator.vibrate?.([600, 400, 600, 1400]);
        } catch {
          /* not supported */
        }
      }, 3000);
    } catch {
      /* autoplay blocked until a gesture — modal still shows */
    }
  }, []);

  const cleanup = useCallback(() => {
    stopRingtone();
    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (audioRef.current) audioRef.current.srcObject = null;
    callIdRef.current = '';
    offerSdpRef.current = '';
    setCall(null);
    setPhase('idle');
    setMuted(false);
    setMinimized(false);
    setSeconds(0);
  }, [stopRingtone]);

  // Call timer while active.
  useEffect(() => {
    if (phase !== 'active') return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => () => cleanup(), [cleanup]);

  /** Build the PeerConnection with mic + remote audio wired. */
  const newPeer = useCallback(
    async (): Promise<RTCPeerConnection> => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      pcRef.current = pc;
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      pc.ontrack = (ev) => {
        if (audioRef.current) {
          audioRef.current.srcObject = ev.streams[0];
          audioRef.current.play().catch(() => {});
        }
      };
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') setPhase('active');
        if (s === 'failed' || s === 'closed' || s === 'disconnected') cleanup();
      };
      return pc;
    },
    [cleanup],
  );

  // ---- inbound answer ----
  const answer = useCallback(async () => {
    if (!call) return;
    stopRingtone();
    setPhase('connecting');
    try {
      const pc = await newPeer();
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdpRef.current });
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      await waitIceComplete(pc);
      const res = await fetch(`/api/calls/${encodeURIComponent(call.callId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'accept',
          sdp: pc.localDescription?.sdp,
          to: call.peer,
        }),
      });
      if (!res.ok) throw new Error(`accept HTTP ${res.status}`);
      setPhase('active');
    } catch (err) {
      console.error('[calls] answer failed:', err);
      cleanup();
    }
  }, [call, stopRingtone, newPeer, cleanup]);

  // ---- outbound dial (Meta) ----
  // createOffer → POST /initiate → the customer's answer arrives later via the
  // `call_answer` SSE. Permission-gated.
  const dialMeta = useCallback(
    async (to: string, name?: string) => {
      const pc = await newPeer();
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await waitIceComplete(pc);
      const res = await fetch('/api/calls/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, sdp: pc.localDescription?.sdp }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        callId?: string;
        needsPermission?: boolean;
      };
      if (!res.ok || !data.callId) {
        if (data.needsPermission) {
          // Keep the modal; drop media and offer to request permission.
          if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach((t) => t.stop());
            localStreamRef.current = null;
          }
          pc.close();
          pcRef.current = null;
          setPhase('permission');
          return;
        }
        throw new Error('initiate failed');
      }
      callIdRef.current = data.callId;
      setCall({ callId: data.callId, peer: to, name, provider: 'meta' });
      setPhase('connecting'); // "chamando…" until the answer arrives
    },
    [newPeer],
  );

  // ---- outbound dial (waha-voip) ----
  // POST /initiate rings the customer; then /webrtc returns the SDP answer
  // synchronously (no permission, no SSE). Goes active via connectionstate.
  const dialWaha = useCallback(
    async (to: string, name?: string) => {
      const initRes = await fetch('/api/calls/waha/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to }),
      });
      const initData = (await initRes.json().catch(() => ({}))) as {
        callId?: string;
      };
      if (!initRes.ok || !initData.callId) throw new Error('waha initiate failed');
      callIdRef.current = initData.callId;
      setCall({ callId: initData.callId, peer: to, name, provider: 'waha' });
      setPhase('connecting');

      const pc = await newPeer();
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await waitIceComplete(pc);
      const rtcRes = await fetch(
        `/api/calls/waha/${encodeURIComponent(initData.callId)}/webrtc`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sdpOffer: pc.localDescription?.sdp }),
        },
      );
      const rtcData = (await rtcRes.json().catch(() => ({}))) as {
        sdpAnswer?: string;
      };
      if (!rtcRes.ok || !rtcData.sdpAnswer) throw new Error('waha webrtc failed');
      await pc.setRemoteDescription({ type: 'answer', sdp: rtcData.sdpAnswer });
    },
    [newPeer],
  );

  const dial = useCallback(
    async (to: string, name?: string, provider: CallProvider = 'meta') => {
      if (pcRef.current || phase !== 'idle') return;
      setDir('out');
      setCall({ callId: '', peer: to, name, provider });
      setPhase('dialing');
      try {
        if (provider === 'waha') await dialWaha(to, name);
        else await dialMeta(to, name);
      } catch (err) {
        console.error('[calls] dial failed:', err);
        cleanup();
      }
    },
    [phase, dialMeta, dialWaha, cleanup],
  );

  // outbound trigger from the header button
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        to?: string;
        name?: string;
        provider?: CallProvider;
      };
      if (detail?.to) void dial(detail.to, detail.name, detail.provider);
    };
    window.addEventListener('fluxia:outbound-call', handler);
    return () => window.removeEventListener('fluxia:outbound-call', handler);
  }, [dial]);

  // ---- SSE ----
  const onEvent = useCallback(
    (e: {
      type: string;
      callId?: unknown;
      from?: unknown;
      callerName?: unknown;
      sdp?: unknown;
      provider?: unknown;
    }) => {
      if (e.type === 'call_incoming') {
        if (pcRef.current || phase !== 'idle') return;
        if (typeof e.sdp !== 'string' || !e.sdp) return;
        offerSdpRef.current = e.sdp;
        setDir('in');
        setCall({
          callId: typeof e.callId === 'string' ? e.callId : '',
          peer: typeof e.from === 'string' ? e.from : '',
          name: typeof e.callerName === 'string' ? e.callerName : undefined,
          provider: e.provider === 'waha' ? 'waha' : 'meta',
        });
        setPhase('ringing');
        startRingtone();
      } else if (e.type === 'call_answer') {
        // customer answered our outbound call
        if (
          pcRef.current &&
          typeof e.sdp === 'string' &&
          e.callId === callIdRef.current
        ) {
          void pcRef.current
            .setRemoteDescription({ type: 'answer', sdp: e.sdp })
            .then(() => setPhase('active'))
            .catch((err) => {
              console.error('[calls] setRemote(answer) failed:', err);
              cleanup();
            });
        }
      } else if (e.type === 'call_status') {
        cleanup();
      }
    },
    [phase, startRingtone, cleanup],
  );
  useServerEvents(onEvent);

  const postAction = (action: 'terminate' | 'reject') => {
    const id = call?.callId || callIdRef.current;
    if (!id || !call) return;
    if (call.provider === 'waha') {
      // waha-voip: hang up = /end, decline = /reject (needs the caller chatId).
      fetch(`/api/calls/waha/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: action === 'terminate' ? 'end' : 'reject',
          from: call.peer,
        }),
      }).catch(() => {});
      return;
    }
    fetch(`/api/calls/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, to: call.peer }),
    }).catch(() => {});
  };

  const reject = useCallback(() => {
    postAction('reject');
    cleanup();
  }, [call, cleanup]);

  const hangup = useCallback(() => {
    postAction('terminate');
    cleanup();
  }, [call, cleanup]);

  const requestPermission = useCallback(async () => {
    if (!call) return;
    try {
      await fetch('/api/calls/permission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: call.peer }),
      });
    } catch {
      /* best-effort */
    }
    cleanup();
  }, [call, cleanup]);

  const toggleMute = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      setMuted(!track.enabled);
    }
  }, []);

  if (phase === 'idle' || !call) return null;

  const who = call.name || call.peer || 'Cliente';
  const statusText =
    phase === 'ringing'
      ? 'está te ligando no WhatsApp…'
      : phase === 'dialing'
        ? 'iniciando ligação…'
        : phase === 'connecting'
          ? dir === 'out'
            ? 'chamando…'
            : 'conectando…'
          : phase === 'permission'
            ? 'ainda não autorizou receber ligação'
            : formatCallDuration(seconds);

  // Minimized: a small floating pill so the whole CRM stays usable during a
  // call (reply to other clients while talking, WhatsApp-style). The <audio>
  // element stays mounted across the toggle so the stream never drops.
  return (
    <>
      <audio ref={audioRef} autoPlay />
      {minimized && phase === 'active' ? (
        <div className="fixed bottom-4 right-4 z-[60] flex items-center gap-3 rounded-2xl border border-border bg-card px-3 py-2 shadow-2xl">
          <span className="relative flex size-9 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
            <Phone className="size-4" />
            <span className="absolute -right-0.5 -top-0.5 size-2.5 animate-pulse rounded-full bg-emerald-500" />
          </span>
          <div className="flex flex-col leading-tight">
            <span className="max-w-[9rem] truncate text-sm font-medium">
              {who}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatCallDuration(seconds)}
            </span>
          </div>
          <button
            onClick={toggleMute}
            title={muted ? 'Ativar microfone' : 'Silenciar'}
            className={`flex size-8 items-center justify-center rounded-full transition ${
              muted
                ? 'bg-red-500 text-white'
                : 'bg-muted text-muted-foreground hover:bg-muted/70'
            }`}
          >
            {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
          </button>
          <button
            onClick={() => setMinimized(false)}
            title="Expandir"
            className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition hover:bg-muted/70"
          >
            <Maximize2 className="size-4" />
          </button>
          <button
            onClick={hangup}
            title="Desligar"
            className="flex size-8 items-center justify-center rounded-full bg-red-500 text-white transition hover:bg-red-600"
          >
            <PhoneOff className="size-4" />
          </button>
        </div>
      ) : (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="relative w-full max-w-xs rounded-2xl border border-border bg-card p-6 text-center shadow-2xl">
        {phase === 'active' && (
          <button
            onClick={() => setMinimized(true)}
            title="Minimizar (continuar atendendo)"
            className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted"
          >
            <Minimize2 className="size-4" />
          </button>
        )}
        <div
          className={`mx-auto flex size-16 items-center justify-center rounded-full ${
            phase === 'permission'
              ? 'bg-amber-500/15 text-amber-600'
              : 'bg-primary/10 text-primary'
          }`}
        >
          {phase === 'permission' ? (
            <ShieldQuestion className="size-7" />
          ) : (
            <Phone className="size-7" />
          )}
        </div>
        <p className="mt-4 text-lg font-semibold text-foreground">{who}</p>
        <p className="mt-1 text-sm text-muted-foreground">{statusText}</p>

        {phase === 'ringing' ? (
          <div className="mt-6 flex items-center justify-center gap-8">
            <button
              onClick={reject}
              className="flex size-14 items-center justify-center rounded-full bg-red-500 text-white transition hover:bg-red-600"
              title="Recusar"
            >
              <PhoneOff className="size-6" />
            </button>
            <button
              onClick={answer}
              className="flex size-14 items-center justify-center rounded-full bg-emerald-500 text-white transition hover:bg-emerald-600"
              title="Atender"
            >
              <Phone className="size-6" />
            </button>
          </div>
        ) : phase === 'permission' ? (
          <div className="mt-6 flex flex-col items-center gap-3">
            <p className="text-xs text-muted-foreground">
              O WhatsApp exige que o cliente autorize antes de você ligar. Envie
              o pedido de permissão — ele aceita na conversa e depois você liga.
            </p>
            <div className="flex gap-3">
              <button
                onClick={cleanup}
                className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
              >
                Cancelar
              </button>
              <button
                onClick={requestPermission}
                className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Pedir permissão
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-6 flex items-center justify-center gap-6">
            <button
              onClick={toggleMute}
              className={`flex size-12 items-center justify-center rounded-full transition ${
                muted
                  ? 'bg-red-500 text-white hover:bg-red-600'
                  : 'bg-muted text-muted-foreground hover:bg-muted/70'
              }`}
              title={muted ? 'Ativar microfone' : 'Silenciar'}
            >
              {muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
            </button>
            <button
              onClick={hangup}
              className="flex size-14 items-center justify-center rounded-full bg-red-500 text-white transition hover:bg-red-600"
              title="Desligar"
            >
              <PhoneOff className="size-6" />
            </button>
          </div>
        )}
          </div>
        </div>
      )}
    </>
  );
}
