'use client';

// ============================================================
// IncomingCallModal — answers WhatsApp voice calls (Meta Business Calling)
// in the browser. Listens for the `call_incoming` SSE event (which carries
// the caller's SDP offer), rings, and on "Atender" runs the WebRTC answer:
//   getUserMedia → setRemote(offer) → createAnswer → gather ICE →
//   POST /api/calls/{id} {action:'accept', sdp, to}. Media (mic/speaker)
//   lives here in the browser; the token stays server-side.
// Mounted once, globally, in the dashboard shell.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff, Mic, MicOff } from 'lucide-react';

import { useServerEvents } from '@/hooks/use-server-events';

type Phase = 'idle' | 'ringing' | 'connecting' | 'active';

interface IncomingCall {
  callId: string;
  from: string;
  callerName?: string;
  sdp: string;
}

/** Wait for ICE gathering to finish (Meta expects a non-trickle SDP answer). */
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
    // Fallback so we never hang if the last candidate is slow.
    setTimeout(resolve, 2500);
  });
}

export function IncomingCallModal() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [call, setCall] = useState<IncomingCall | null>(null);
  const [muted, setMuted] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ringCtxRef = useRef<AudioContext | null>(null);
  const ringTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopRingtone = useCallback(() => {
    if (ringTimerRef.current) {
      clearInterval(ringTimerRef.current);
      ringTimerRef.current = null;
    }
    ringCtxRef.current?.close().catch(() => {});
    ringCtxRef.current = null;
  }, []);

  const startRingtone = useCallback(() => {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctx();
      ringCtxRef.current = ctx;
      const beep = () => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = 480;
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
        o.connect(g).connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + 1);
      };
      beep();
      ringTimerRef.current = setInterval(beep, 2000);
    } catch {
      // Autoplay blocked until a gesture — fine, the modal is still visible.
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
    setCall(null);
    setPhase('idle');
    setMuted(false);
  }, [stopRingtone]);

  useEffect(() => () => cleanup(), [cleanup]);

  const onEvent = useCallback(
    (e: {
      type: string;
      callId?: unknown;
      from?: unknown;
      callerName?: unknown;
      sdp?: unknown;
    }) => {
      if (e.type === 'call_incoming') {
        if (pcRef.current || phase !== 'idle') return; // busy
        if (typeof e.sdp !== 'string' || !e.sdp) return; // no offer to answer
        setCall({
          callId: typeof e.callId === 'string' ? e.callId : '',
          from: typeof e.from === 'string' ? e.from : '',
          callerName: typeof e.callerName === 'string' ? e.callerName : undefined,
          sdp: e.sdp,
        });
        setPhase('ringing');
        startRingtone();
      } else if (e.type === 'call_status') {
        // The other side ended/rejected the call.
        cleanup();
      }
    },
    [phase, startRingtone, cleanup],
  );
  useServerEvents(onEvent);

  const answer = useCallback(async () => {
    if (!call) return;
    stopRingtone();
    setPhase('connecting');
    try {
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
      await pc.setRemoteDescription({ type: 'offer', sdp: call.sdp });
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      await waitIceComplete(pc);
      const answerSdp = pc.localDescription?.sdp;
      const res = await fetch(`/api/calls/${encodeURIComponent(call.callId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'accept', sdp: answerSdp, to: call.from }),
      });
      if (!res.ok) throw new Error(`accept HTTP ${res.status}`);
      setPhase('active');
    } catch (err) {
      console.error('[calls] answer failed:', err);
      cleanup();
    }
  }, [call, stopRingtone, cleanup]);

  const post = (action: string) => {
    if (!call) return;
    fetch(`/api/calls/${encodeURIComponent(call.callId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, to: call.from }),
    }).catch(() => {});
  };

  const reject = useCallback(() => {
    post('reject');
    cleanup();
  }, [call, cleanup]);

  const hangup = useCallback(() => {
    post('terminate');
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

  const who = call.callerName || call.from || 'Cliente';
  const statusText =
    phase === 'ringing'
      ? 'está te ligando no WhatsApp…'
      : phase === 'connecting'
        ? 'conectando…'
        : 'em ligação';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <audio ref={audioRef} autoPlay />
      <div className="w-full max-w-xs rounded-2xl border border-border bg-card p-6 text-center shadow-2xl">
        <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Phone className="size-7" />
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
  );
}
