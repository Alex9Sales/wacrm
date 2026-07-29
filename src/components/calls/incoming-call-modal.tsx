'use client';

// ============================================================
// Call modal for WhatsApp voice calls, both ways and both transports:
//  - INBOUND: `call_incoming` SSE carries the caller's SDP offer (Meta) → ring →
//    Atender → answer (setRemote(offer) → createAnswer → POST accept).
//  - OUTBOUND: a `fluxia:outbound-call` window event (from the conversation
//    header "Ligar" button) → createOffer → POST /api/calls/initiate → the
//    customer's answer arrives via the `call_answer` SSE → setRemote(answer).
// Media (mic/speaker) lives in the browser; the token stays server-side.
// Mounted once, globally, in the dashboard shell.
//
// MULTI-LEG: WhatsApp allows ONE active call per NUMBER, so two calls can only
// be live on DIFFERENT channels. This holds a map of legs — exactly one active,
// the rest parked (mic cut, audio muted, connection alive). The ordering rules
// live in ./call-legs; only media wiring is here.
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
  Pause,
  BellOff,
  Bell,
} from 'lucide-react';

import { toast } from 'sonner';

import { useServerEvents } from '@/hooks/use-server-events';
import { getNotificationPrefs } from '@/lib/notifications/prefs';
import { floatToPcm, pcmToFloat } from '@/lib/calls/pcm';
import { formatCallDuration } from '@/lib/inbox/call-log';
import { routeCallStatus, type CallProvider } from './call-routing';
import {
  findByCallId,
  isDuplicateIncoming,
  isHeld,
  micLive,
  pickAutoResume,
  pickForeground,
  type Leg,
} from './call-legs';

/** Fire this to start an outbound call from anywhere in the app. Defaults to
 *  the official Meta transport; pass 'waha' for the unofficial waha-voip one.
 *  conversationId lets the waha path log the call in the thread on hang-up;
 *  channelId routes the call through that channel's own number. */
export function startOutboundCall(
  to: string,
  name?: string,
  provider: CallProvider = 'meta',
  conversationId?: string,
  channelId?: string,
) {
  window.dispatchEvent(
    new CustomEvent('fluxia:outbound-call', {
      detail: { to, name, provider, conversationId, channelId },
    }),
  );
}

/** Take over a live AI voice call (Fatia 5B handoff). Fired from the "Assumir"
 *  button on the VoiceLiveBadge / VoiceMonitor: the agent joins the in-progress
 *  waha-voip call (claim + own audio leg); the AI bridge sees the claim, says a
 *  short handoff line, and drops its leg. waha-voip only. */
export function takeOverVoiceCall(
  callId: string,
  channelId?: string,
  peer?: string,
  name?: string,
) {
  window.dispatchEvent(
    new CustomEvent('fluxia:voice-takeover', {
      detail: { callId, channelId, peer, name },
    }),
  );
}

/** How long a takeover waits for the AI to finish its handoff line before
 *  attaching anyway. The bridge's own safety net releases at 6s, so this sits
 *  just past it — long enough for the goodbye, short enough not to feel stuck. */
const HANDOFF_WAIT_MS = 7000;

/** Per-leg media. Lives in a ref (never in state): these are imperative
 *  objects and re-rendering must not recreate them. */
interface LegMedia {
  pc: RTCPeerConnection | null;
  localStream: MediaStream | null;
  audioCtx: AudioContext | null; // waha-voip PCM path
  audioEl: HTMLAudioElement | null;
  ringCtx: AudioContext | null;
  ringTimer: ReturnType<typeof setInterval> | null;
  offerSdp: string; // inbound Meta offer to answer
  logged: boolean; // guards against double-finalizing the call log
  /** waha: the capture worklet reads this every block. Gating here (rather
   *  than on the track) is what lets one leg go quiet while another talks —
   *  each leg has its own AudioContext, so a shared mic stream still works. */
  sendMic: boolean;
}

function emptyMedia(): LegMedia {
  return {
    pc: null,
    localStream: null,
    audioCtx: null,
    audioEl: null,
    ringCtx: null,
    ringTimer: null,
    offerSdp: '',
    logged: false,
    sendMic: true,
  };
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

function newAudioContext(sampleRate?: number): AudioContext {
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  return sampleRate ? new Ctx({ sampleRate }) : new Ctx();
}

export function IncomingCallModal() {
  const [legs, setLegs] = useState<Leg[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);

  const mediaRef = useRef<Map<string, LegMedia>>(new Map());
  const keySeq = useRef(0);
  /** Takeovers waiting for the AI to finish its handoff line (keyed by callId).
   *  Resolved by the `voice_live` phase 'end' the bridge posts when it goes
   *  quiet — see joinCall. */
  const handoffWaiters = useRef<Map<string, () => void>>(new Map());
  // Mirrors `legs` for the SSE handler and async media callbacks, which must
  // read the current legs without being re-created on every state change.
  const legsRef = useRef<Leg[]>([]);
  legsRef.current = legs;

  /** Media for a live leg, creating it on first use. Never call this for a leg
   *  that closeLeg already dropped — see `mediaOf` for the read-only path. */
  const media = useCallback((key: string): LegMedia => {
    let m = mediaRef.current.get(key);
    if (!m) {
      m = emptyMedia();
      mediaRef.current.set(key, m);
    }
    return m;
  }, []);

  /** Read-only lookup: returns undefined for a dropped leg instead of
   *  resurrecting it. Resurrection would reset the `logged` once-guard (double
   *  call-log entries) and leak an entry that nothing ever deletes. */
  const mediaOf = useCallback(
    (key: string): LegMedia | undefined => mediaRef.current.get(key),
    [],
  );

  const patchLeg = useCallback((key: string, patch: Partial<Leg>) => {
    setLegs((prev) =>
      prev.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    );
  }, []);

  // ---- ringtones (per leg: silencing one must not silence another) ----

  const stopRing = useCallback(
    (key: string) => {
      const m = mediaRef.current.get(key);
      if (!m) return;
      if (m.ringTimer) {
        clearInterval(m.ringTimer);
        m.ringTimer = null;
      }
      m.ringCtx?.close().catch(() => {});
      m.ringCtx = null;
      try {
        navigator.vibrate?.(0);
      } catch {
        /* not supported */
      }
    },
    [],
  );

  // Outbound "chamando…" ringback (what the CALLER hears): single 425 Hz tone,
  // Brazilian cadence (1 s on / 4 s off).
  const startRingback = useCallback(
    (key: string) => {
      stopRing(key); // idempotent: never leak a previous ring/ringback context
      try {
        const ctx = newAudioContext();
        media(key).ringCtx = ctx;
        const beep = () => {
          const t0 = ctx.currentTime;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.05);
          g.gain.setValueAtTime(0.08, t0 + 0.95);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.0);
          g.connect(ctx.destination);
          const o = ctx.createOscillator();
          o.type = 'sine';
          o.frequency.value = 425;
          o.connect(g);
          o.start(t0);
          o.stop(t0 + 1.0);
        };
        beep();
        media(key).ringTimer = setInterval(beep, 5000);
      } catch {
        /* autoplay blocked — silent dialing still works */
      }
    },
    [media, stopRing],
  );

  const startRingtone = useCallback(
    (key: string) => {
      stopRing(key); // idempotent: a duplicate call_incoming must not leak a 2nd ctx
      try {
        navigator.vibrate?.([600, 400, 600, 1400]);
      } catch {
        /* not supported */
      }
      try {
        const ctx = newAudioContext();
        media(key).ringCtx = ctx;
        // A telephone-style "brrring": a dual-tone (440+480 Hz) burst that
        // pulses twice, then a gap — repeated on a ~3s cadence.
        const ringBurst = () => {
          const t0 = ctx.currentTime;
          for (const start of [0, 0.5]) {
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t0 + start);
            g.gain.exponentialRampToValueAtTime(0.12, t0 + start + 0.04);
            g.gain.setValueAtTime(0.12, t0 + start + 0.35);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + 0.42);
            g.connect(ctx.destination);
            for (const f of [440, 480]) {
              const o = ctx.createOscillator();
              o.type = 'sine';
              o.frequency.value = f;
              o.connect(g);
              o.start(t0 + start);
              o.stop(t0 + start + 0.42);
            }
          }
        };
        ringBurst();
        media(key).ringTimer = setInterval(() => {
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
    },
    [media, stopRing],
  );

  // ---- audio gating ----

  // One declarative pass instead of remembering to gate audio at every call
  // site: whenever the legs or the active one change, push the derived
  // hold/mute state onto the media. A parked leg stops feeding the wire and
  // goes silent in the agent's ear, but its connection stays up.
  useEffect(() => {
    for (const leg of legs) {
      const m = mediaRef.current.get(leg.key);
      if (!m) continue;
      const micOn = micLive(leg, activeKey);
      m.sendMic = micOn; // waha: read by the capture worklet each block
      const track = m.localStream?.getAudioTracks()[0];
      if (track) track.enabled = micOn; // Meta: RTP track gate
      if (m.audioEl) m.audioEl.muted = isHeld(leg, activeKey);
    }
  }, [legs, activeKey]);

  // Resume the survivor when the agent's ear frees up and the choice is
  // unambiguous, and forget "minimized" once every call is gone — otherwise
  // the next answered call would jump straight to the pill.
  useEffect(() => {
    const resume = pickAutoResume(legs, activeKey);
    if (resume) setActiveKey(resume);
    if (!legs.length) {
      setMinimized(false);
      if (activeKey) setActiveKey(null);
    }
  }, [legs, activeKey]);

  // ---- teardown ----

  /** Stamp the call log for a leg that is going away. waha-voip emits no
   *  "terminated" webhook, so the browser is what closes the row out — and an
   *  un-closed row makes the channel read BUSY for 30 minutes, silently
   *  auto-rejecting real customers. Only ever fires once per leg. */
  const finalizeLeg = useCallback(
    (leg: Leg) => {
      const m = mediaOf(leg.key);
      if (!m || m.logged) return;
      if (leg.provider !== 'waha') return;
      const id = leg.callId;
      if (!id && !leg.conversationId) return;
      m.logged = true;
      const cid = leg.conversationId;
      fetch('/api/calls/waha/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: cid,
          durationSec: leg.seconds,
          answered: leg.phase === 'active',
          callId: id,
        }),
      })
        .then(() => {
          // Refresh the thread live (the SSE ping can race with modal cleanup).
          if (cid)
            window.dispatchEvent(
              new CustomEvent('fluxia:conversation-refresh', {
                detail: { conversationId: cid },
              }),
            );
        })
        .catch(() => {});
    },
    [mediaOf],
  );

  /** Drop a leg and free its media. Who takes over (and whether the pill
   *  should collapse) is reconciled by the effects above — this only has to
   *  say that the leg is gone. */
  const closeLeg = useCallback(
    (key: string) => {
      stopRing(key);
      const m = mediaRef.current.get(key);
      if (m) {
        if (m.pc) {
          m.pc.ontrack = null;
          m.pc.onconnectionstatechange = null;
          m.pc.close();
        }
        m.localStream?.getTracks().forEach((t) => t.stop());
        m.audioCtx?.close().catch(() => {});
        if (m.audioEl) {
          m.audioEl.pause();
          m.audioEl.srcObject = null;
        }
        mediaRef.current.delete(key);
      }
      setLegs((prev) => prev.filter((l) => l.key !== key));
      setActiveKey((cur) => (cur === key ? null : cur));
    },
    [stopRing],
  );

  /** Close every leg — unmount only. */
  const closeAll = useCallback(() => {
    for (const key of Array.from(mediaRef.current.keys())) {
      stopRing(key);
      const m = mediaRef.current.get(key);
      if (!m) continue;
      m.pc?.close();
      m.localStream?.getTracks().forEach((t) => t.stop());
      m.audioCtx?.close().catch(() => {});
      if (m.audioEl) m.audioEl.srcObject = null;
    }
    mediaRef.current.clear();
  }, [stopRing]);

  useEffect(() => () => closeAll(), [closeAll]);

  // Call timer. A parked leg is still connected, so it keeps counting.
  // Keyed on "is anything live" rather than on `legs`: this effect writes to
  // `legs` every second, so depending on it would tear down and rebuild the
  // interval on its own tick — and any unrelated change (mute, hold) would
  // reset the second in progress.
  const anyActive = legs.some((l) => l.phase === 'active');
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => {
      setLegs((prev) =>
        prev.map((l) =>
          l.phase === 'active' ? { ...l, seconds: l.seconds + 1 } : l,
        ),
      );
    }, 1000);
    return () => clearInterval(t);
  }, [anyActive]);

  // ---- media wiring ----

  /** Build the PeerConnection with mic + remote audio wired (Meta transport). */
  const newPeer = useCallback(
    async (key: string): Promise<RTCPeerConnection> => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const m = media(key);
      m.localStream = stream;
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      m.pc = pc;
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      const el = new Audio();
      el.autoplay = true;
      m.audioEl = el;
      pc.ontrack = (ev) => {
        el.srcObject = ev.streams[0];
        el.play().catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') patchLeg(key, { phase: 'active' });
        if (s === 'failed' || s === 'closed' || s === 'disconnected') {
          // The leg died without anyone hanging up (network blip, tab sleep).
          // Finalize before dropping it or the row stays open and wedges the
          // channel as busy.
          const leg = legsRef.current.find((l) => l.key === key);
          if (leg) finalizeLeg(leg);
          closeLeg(key);
        }
      };
      return pc;
    },
    [media, patchLeg, closeLeg, finalizeLeg],
  );

  // ---- waha-voip browser audio (shared by dial + answer) ----
  // The browser negotiates audio over a "pcm" DataChannel (waha-voip's
  // protocol — NOT an RTP track): mic → capture worklet → 16 kHz s16le PCM →
  // DC; DC → Float32 → playback worklet → speaker. /webrtc returns the SDP
  // answer synchronously.
  const wahaConnectAudio = useCallback(
    async (
      key: string,
      callId: string,
      channelId?: string,
      ringUntilAudio = false,
    ) => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      const m = media(key);
      m.localStream = stream;
      // No STUN: waha-voip advertises its public IP directly and learns the
      // browser's address from the incoming ICE checks (peer-reflexive).
      const pc = new RTCPeerConnection({ iceServers: [] });
      m.pc = pc;
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        // Outbound: the browser↔server leg connects in ~1 s, long before the
        // customer answers — hold "chamando…" until real audio arrives.
        if (s === 'connected' && !ringUntilAudio) patchLeg(key, { phase: 'active' });
        if (s === 'failed' || s === 'closed' || s === 'disconnected') {
          const leg = legsRef.current.find((l) => l.key === key);
          if (leg) finalizeLeg(leg);
          closeLeg(key);
        }
      };
      const dc = pc.createDataChannel('pcm', { ordered: true });
      dc.binaryType = 'arraybuffer';

      const ctx = newAudioContext(16000);
      m.audioCtx = ctx;
      await ctx.audioWorklet.addModule('/worklets/capture-processor.js');
      await ctx.audioWorklet.addModule('/worklets/playback-processor.js');
      await ctx.resume();

      const src = ctx.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(ctx, 'capture-processor');
      capture.port.onmessage = (ev) => {
        // sendMic is the hold/mute gate: parked legs stop feeding the wire,
        // so the customer hears silence while the connection stays up.
        if (m.sendMic && dc.readyState === 'open')
          dc.send(floatToPcm(ev.data as Float32Array));
      };
      src.connect(capture);
      capture.connect(ctx.destination);

      const playback = new AudioWorkletNode(ctx, 'playback-processor');
      const dest = ctx.createMediaStreamDestination();
      playback.connect(dest);
      let gotAudio = false;
      dc.onmessage = (ev) => {
        // First peer PCM frame = the call is genuinely live (the server only
        // streams audio once the callee accepts) — stop the ringback.
        if (!gotAudio) {
          gotAudio = true;
          if (ringUntilAudio) {
            stopRing(key);
            patchLeg(key, { phase: 'active' });
          }
        }
        playback.port.postMessage(pcmToFloat(ev.data as ArrayBuffer));
      };
      const el = new Audio();
      el.autoplay = true;
      el.srcObject = dest.stream;
      m.audioEl = el;
      el.play().catch(() => {});

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitIceComplete(pc);
      const rtcRes = await fetch(
        `/api/calls/waha/${encodeURIComponent(callId)}/webrtc`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sdpOffer: pc.localDescription?.sdp, channelId }),
        },
      );
      const rtcData = (await rtcRes.json().catch(() => ({}))) as {
        sdpAnswer?: string;
      };
      if (!rtcRes.ok || !rtcData.sdpAnswer) throw new Error('waha webrtc failed');
      await pc.setRemoteDescription({ type: 'answer', sdp: rtcData.sdpAnswer });
    },
    [media, patchLeg, closeLeg, finalizeLeg, stopRing],
  );

  // ---- actions ----

  /** Bring a leg to the front. Everything else that is connected is parked by
   *  definition — `held` is derived from this, so there is nothing else to set. */
  const activate = useCallback((key: string) => setActiveKey(key), []);

  const answer = useCallback(
    async (key: string) => {
      const leg = legsRef.current.find((l) => l.key === key);
      if (!leg) return;
      stopRing(key);
      // Taking this leg parks whatever else was live: two live legs would mix
      // both customers into the agent's headset.
      patchLeg(key, { phase: 'connecting' });
      setActiveKey(key);
      try {
        if (leg.provider === 'waha') {
          // waha-voip: the server answers the WhatsApp call, then the browser
          // negotiates its own audio leg (PCM DataChannel).
          const res = await fetch(
            `/api/calls/waha/${encodeURIComponent(leg.callId)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'accept', channelId: leg.channelId }),
            },
          );
          // 409 = another agent claimed it first (the call rings for everyone).
          if (res.status === 409) {
            toast.info('Essa ligação já foi atendida por outro atendente.');
            closeLeg(key);
            return;
          }
          if (!res.ok) throw new Error(`waha accept HTTP ${res.status}`);
          await wahaConnectAudio(key, leg.callId, leg.channelId);
          return;
        }
        const pc = await newPeer(key);
        await pc.setRemoteDescription({
          type: 'offer',
          sdp: media(key).offerSdp,
        });
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        await waitIceComplete(pc);
        const res = await fetch(`/api/calls/${encodeURIComponent(leg.callId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'accept',
            sdp: pc.localDescription?.sdp,
            to: leg.peer,
          }),
        });
        if (!res.ok) throw new Error(`accept HTTP ${res.status}`);
        patchLeg(key, { phase: 'active' });
      } catch (err) {
        console.error('[calls] answer failed:', err);
        closeLeg(key);
      }
    },
    [stopRing, newPeer, media, wahaConnectAudio, patchLeg, closeLeg],
  );

  // ---- takeover (Fatia 5B handoff): join a live AI voice call ----
  // The agent clicks "Assumir" on the AI-call badge/monitor. Unlike answer(),
  // there is no ringing leg — we open a fresh one straight into 'connecting',
  // claim the call (writes claimed_by = me; the AI never sets it, so we win the
  // WHERE claimed_by IS NULL update even though it already reads 'answered'),
  // and attach our own audio leg to the in-progress gows call. The AI bridge
  // polls voice-handoff, sees the claim, speaks a short line and drops its leg —
  // gows keeps the call live on ours. waha-voip only.
  const joinCall = useCallback(
    async (
      callId: string,
      channelId?: string,
      peer?: string,
      name?: string,
    ) => {
      if (!callId) return;
      // Already holding a leg for this call? Just bring it to the front.
      const existing = findByCallId(legsRef.current, callId);
      if (existing) {
        setActiveKey(existing.key);
        return;
      }
      keySeq.current += 1;
      const key = `leg-${keySeq.current}`;
      mediaRef.current.set(key, emptyMedia());
      setLegs((prev) => [
        ...prev,
        {
          key,
          callId,
          peer: peer || 'Cliente',
          name,
          provider: 'waha',
          channelId,
          phase: 'connecting',
          dir: 'in',
          muted: false,
          ringMuted: false,
          seconds: 0,
        },
      ]);
      setActiveKey(key);
      try {
        // 'claim' = grab the lock WITHOUT re-accepting at the engine (the AI
        // already accepted); the browser then attaches its own media leg.
        const res = await fetch(
          `/api/calls/waha/${encodeURIComponent(callId)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'claim', channelId }),
          },
        );
        // 409 = another human already took this call over.
        if (res.status === 409) {
          toast.info('Essa ligação já foi assumida por outro atendente.');
          closeLeg(key);
          return;
        }
        if (!res.ok) throw new Error(`waha accept HTTP ${res.status}`);
        // Let the AI finish its handoff line and go quiet BEFORE we attach.
        // gows keeps ONE media transport per call: our offer SWAPS it, which
        // cuts the AI off mid-sentence (and, on 23/07, killed the call). The
        // bridge posts voice_live 'end' when it's done — wait for that, or
        // give up after a beat and take the call anyway.
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            handoffWaiters.current.delete(callId);
            resolve();
          };
          const timer = setTimeout(done, HANDOFF_WAIT_MS);
          handoffWaiters.current.set(callId, done);
        });
        await wahaConnectAudio(key, callId, channelId);
      } catch (err) {
        console.error('[calls] takeover failed:', err);
        toast.error('Não consegui assumir a ligação.');
        closeLeg(key);
      }
    },
    [setActiveKey, wahaConnectAudio, closeLeg],
  );

  const postAction = useCallback((leg: Leg, action: 'terminate' | 'reject') => {
    const id = leg.callId;
    if (!id) return;
    if (leg.provider === 'waha') {
      // waha-voip: hang up = /end, decline = /reject (needs the caller's raw
      // chatId — @lid callers can't be reconstructed from the display peer).
      fetch(`/api/calls/waha/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: action === 'terminate' ? 'end' : 'reject',
          from: leg.wahaFrom ?? leg.peer,
          channelId: leg.channelId,
        }),
      }).catch(() => {});
      return;
    }
    fetch(`/api/calls/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, to: leg.peer }),
    }).catch(() => {});
  }, []);

  const reject = useCallback(
    (key: string) => {
      const leg = legsRef.current.find((l) => l.key === key);
      if (!leg) return;
      postAction(leg, 'reject');
      // No finalize here: the server's reject makes gows fire call.rejected,
      // and that webhook both stamps ended_at and logs the missed call.
      closeLeg(key);
    },
    [postAction, closeLeg],
  );

  const hangup = useCallback(
    (key: string) => {
      const leg = legsRef.current.find((l) => l.key === key);
      if (!leg) return;
      postAction(leg, 'terminate');
      finalizeLeg(leg);
      closeLeg(key);
    },
    [postAction, finalizeLeg, closeLeg],
  );

  const toggleMute = useCallback(
    (key: string) => {
      setLegs((prev) =>
        prev.map((l) => (l.key === key ? { ...l, muted: !l.muted } : l)),
      );
    },
    [],
  );

  const toggleRingMute = useCallback(
    (key: string) => {
      const leg = legsRef.current.find((l) => l.key === key);
      if (!leg) return;
      if (!leg.ringMuted) stopRing(key);
      else startRingtone(key);
      patchLeg(key, { ringMuted: !leg.ringMuted });
    },
    [stopRing, startRingtone, patchLeg],
  );

  const requestPermission = useCallback(
    async (key: string) => {
      const leg = legsRef.current.find((l) => l.key === key);
      if (!leg) return;
      try {
        await fetch('/api/calls/permission', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: leg.peer }),
        });
      } catch {
        /* best-effort */
      }
      closeLeg(key);
    },
    [closeLeg],
  );

  // ---- outbound dial ----

  const dial = useCallback(
    async (
      to: string,
      name?: string,
      provider: CallProvider = 'meta',
      conversationId?: string,
      channelId?: string,
    ) => {
      // One active call per NUMBER: dialing out on a channel that is already
      // on a call would just be refused by WhatsApp.
      if (
        channelId &&
        legsRef.current.some((l) => l.channelId === channelId)
      ) {
        toast.error('Esse número já está em uma ligação.');
        return;
      }
      keySeq.current += 1;
      const key = `leg-${keySeq.current}`;
      mediaRef.current.set(key, emptyMedia());
      const leg: Leg = {
        key,
        callId: '',
        peer: to,
        name,
        provider,
        conversationId,
        channelId,
        phase: 'dialing',
        dir: 'out',
        muted: false,
        ringMuted: false,
        seconds: 0,
      };
      setLegs((prev) => [...prev, leg]);
      setActiveKey(key); // parks whatever was live — held is derived from this
      try {
        if (provider === 'waha') {
          const initRes = await fetch('/api/calls/waha/initiate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to, channelId }),
          });
          const initData = (await initRes.json().catch(() => ({}))) as {
            callId?: string;
          };
          if (!initRes.ok || !initData.callId)
            throw new Error('waha initiate failed');
          patchLeg(key, { callId: initData.callId, phase: 'connecting' });
          startRingback(key); // "tuuu… tuuu" until the customer actually answers
          await wahaConnectAudio(key, initData.callId, channelId, true);
          return;
        }
        const pc = await newPeer(key);
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
            // Keep the leg; drop media and offer to request permission.
            const m = media(key);
            m.localStream?.getTracks().forEach((t) => t.stop());
            m.localStream = null;
            m.pc?.close();
            m.pc = null;
            patchLeg(key, { phase: 'permission' });
            return;
          }
          throw new Error('initiate failed');
        }
        patchLeg(key, { callId: data.callId, phase: 'connecting' });
      } catch (err) {
        console.error('[calls] dial failed:', err);
        closeLeg(key);
      }
    },
    [patchLeg, startRingback, wahaConnectAudio, newPeer, media, closeLeg],
  );

  // outbound trigger from the header button
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        to?: string;
        name?: string;
        provider?: CallProvider;
        conversationId?: string;
        channelId?: string;
      };
      if (detail?.to)
        void dial(
          detail.to,
          detail.name,
          detail.provider,
          detail.conversationId,
          detail.channelId,
        );
    };
    window.addEventListener('fluxia:outbound-call', handler);
    return () => window.removeEventListener('fluxia:outbound-call', handler);
  }, [dial]);

  // "Assumir" on the AI-call badge/monitor → take over the live call.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        callId?: string;
        channelId?: string;
        peer?: string;
        name?: string;
      };
      if (detail?.callId)
        void joinCall(
          detail.callId,
          detail.channelId,
          detail.peer,
          detail.name,
        );
    };
    window.addEventListener('fluxia:voice-takeover', handler);
    return () => window.removeEventListener('fluxia:voice-takeover', handler);
  }, [joinCall]);

  // ---- SSE ----
  const onEvent = useCallback(
    (e: {
      type: string;
      callId?: unknown;
      from?: unknown;
      callerName?: unknown;
      sdp?: unknown;
      provider?: unknown;
      channelId?: unknown;
      callerLid?: unknown;
      status?: unknown;
      phase?: unknown;
    }) => {
      const eventCallId = typeof e.callId === 'string' ? e.callId : '';
      if (e.type === 'call_incoming') {
        // Opt-out (per browser, Configurações → Notificações): teammates who
        // answer on the phone itself, not the CRM, can silence inbound rings
        // here entirely. Outbound dialing (fluxia:outbound-call) is a
        // separate path and is never affected by this flag.
        if (!getNotificationPrefs().callRingEnabled) return;
        // Dedup: waha/gows can redeliver call.received for one call.
        if (!eventCallId) return;
        if (isDuplicateIncoming(legsRef.current, eventCallId)) return;
        const isWaha = e.provider === 'waha';
        // Meta carries the caller's SDP offer up front; waha negotiates the
        // browser leg only at answer time, so no SDP is expected here.
        if (!isWaha && (typeof e.sdp !== 'string' || !e.sdp)) return;
        const rawFrom = typeof e.from === 'string' ? e.from : '';
        // waha inbound `from` now carries the resolved real phone (the
        // webhook maps @lid → CallCreatorAlt) — show the digits.
        const display = isWaha
          ? /@(c\.us|s\.whatsapp\.net)$/.test(rawFrom)
            ? rawFrom.split('@')[0].split(':')[0]
            : 'WhatsApp'
          : rawFrom;
        keySeq.current += 1;
        const key = `leg-${keySeq.current}`;
        const m = emptyMedia();
        if (typeof e.sdp === 'string') m.offerSdp = e.sdp;
        mediaRef.current.set(key, m);
        setLegs((prev) => [
          ...prev,
          {
            key,
            callId: eventCallId,
            peer: display,
            name: typeof e.callerName === 'string' ? e.callerName : undefined,
            provider: isWaha ? 'waha' : 'meta',
            channelId: typeof e.channelId === 'string' ? e.channelId : undefined,
            // Reject must target the caller's chatId gows knows: the @lid when
            // present, else the phone chatId in `from`.
            wahaFrom: isWaha
              ? typeof e.callerLid === 'string'
                ? e.callerLid
                : rawFrom
              : undefined,
            phase: 'ringing',
            dir: 'in',
            muted: false,
            held: false,
            ringMuted: false,
            seconds: 0,
          },
        ]);
        startRingtone(key);
      } else if (e.type === 'call_answer') {
        // customer answered our outbound call
        const leg = findByCallId(legsRef.current, eventCallId);
        if (!leg || typeof e.sdp !== 'string') return;
        const pc = media(leg.key).pc;
        if (!pc) return;
        void pc
          .setRemoteDescription({ type: 'answer', sdp: e.sdp })
          .then(() => patchLeg(leg.key, { phase: 'active' }))
          .catch((err) => {
            console.error('[calls] setRemote(answer) failed:', err);
            closeLeg(leg.key);
          });
      } else if (e.type === 'call_claimed') {
        // Another agent answered this ringing call → stand down. The agent who
        // won is already past 'ringing' (answer() flips the phase before it
        // calls the API), so this only dismisses the losers.
        const leg = findByCallId(legsRef.current, eventCallId);
        if (leg && leg.phase === 'ringing') closeLeg(leg.key);
      } else if (e.type === 'voice_live') {
        // The AI finished its handoff line and went silent — a takeover
        // waiting on this call can now attach its audio leg (joinCall).
        if (e.phase === 'end' && eventCallId) {
          handoffWaiters.current.get(eventCallId)?.();
        }
      } else if (e.type === 'call_status') {
        // The stream is account-wide: find the leg this belongs to, if any.
        const leg = eventCallId
          ? findByCallId(legsRef.current, eventCallId)
          : legsRef.current.find((l) => l.key === activeKey);
        if (!leg) return;
        const action = routeCallStatus({
          eventCallId,
          eventStatus: typeof e.status === 'string' ? e.status : '',
          currentCallId: leg.callId,
          provider: leg.provider,
          dir: leg.dir,
          phase: leg.phase,
        });
        if (action === 'ignore') return;
        if (action === 'go-active') {
          // Backs up the first-audio-frame trigger in wahaConnectAudio.
          stopRing(leg.key);
          patchLeg(leg.key, { phase: 'active' });
          return;
        }
        // The peer ended it — close the row out before dropping the leg.
        finalizeLeg(leg);
        closeLeg(leg.key);
      }
    },
    [
      activeKey,
      startRingtone,
      stopRing,
      media,
      patchLeg,
      closeLeg,
      finalizeLeg,
    ],
  );
  useServerEvents(onEvent);

  // ---- render ----

  const front = pickForeground(legs, activeKey);
  if (!front) return null;

  const others = legs.filter((l) => l.key !== front.key);
  const frontHeld = isHeld(front, activeKey);
  const who = (l: Leg) => l.name || l.peer || 'Cliente';
  const statusText =
    front.phase === 'ringing'
      ? 'está te ligando no WhatsApp…'
      : front.phase === 'dialing'
        ? 'iniciando ligação…'
        : front.phase === 'connecting'
          ? front.dir === 'out'
            ? 'chamando…'
            : 'conectando…'
          : front.phase === 'permission'
            ? 'ainda não autorizou receber ligação'
            : frontHeld
              ? `em espera • ${formatCallDuration(front.seconds)}`
              : formatCallDuration(front.seconds);

  // Parked/ringing legs ride along as a stack so the agent can switch, silence
  // a ringer, or hang one up without losing the call in front.
  const legStack = others.length ? (
    <div className="mb-3 flex flex-col gap-2">
      {others.map((l) => (
        <div
          key={l.key}
          className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 shadow-lg"
        >
          <span
            className={`flex size-8 shrink-0 items-center justify-center rounded-full ${
              l.phase === 'ringing'
                ? 'animate-pulse bg-amber-500/15 text-amber-600'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {l.phase === 'ringing' ? (
              <Phone className="size-4" />
            ) : (
              <Pause className="size-4" />
            )}
          </span>
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="max-w-[8rem] truncate text-sm font-medium">
              {who(l)}
            </span>
            <span className="text-xs text-muted-foreground">
              {l.phase === 'ringing'
                ? 'tocando…'
                : `em espera • ${formatCallDuration(l.seconds)}`}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {l.phase === 'ringing' && (
              <button
                onClick={() => toggleRingMute(l.key)}
                title={l.ringMuted ? 'Voltar a tocar' : 'Silenciar o toque'}
                className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition hover:bg-muted/70"
              >
                {l.ringMuted ? (
                  <BellOff className="size-4" />
                ) : (
                  <Bell className="size-4" />
                )}
              </button>
            )}
            <button
              onClick={() => (l.phase === 'ringing' ? answer(l.key) : activate(l.key))}
              title={l.phase === 'ringing' ? 'Atender' : 'Voltar para esta'}
              className="flex size-8 items-center justify-center rounded-full bg-emerald-500 text-white transition hover:bg-emerald-600"
            >
              <Phone className="size-4" />
            </button>
            <button
              onClick={() => (l.phase === 'ringing' ? reject(l.key) : hangup(l.key))}
              title={l.phase === 'ringing' ? 'Recusar' : 'Desligar'}
              className="flex size-8 items-center justify-center rounded-full bg-red-500 text-white transition hover:bg-red-600"
            >
              <PhoneOff className="size-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  ) : null;

  // Minimized: a small floating pill so the whole CRM stays usable during a
  // call (reply to other clients while talking, WhatsApp-style).
  if (minimized && front.phase === 'active') {
    return (
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col items-end">
        {legStack}
        <div className="flex items-center gap-3 rounded-2xl border border-border bg-card px-3 py-2 shadow-2xl">
          <span className="relative flex size-9 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
            <Phone className="size-4" />
            <span className="absolute -right-0.5 -top-0.5 size-2.5 animate-pulse rounded-full bg-emerald-500" />
          </span>
          <div className="flex flex-col leading-tight">
            <span className="max-w-[9rem] truncate text-sm font-medium">
              {who(front)}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {frontHeld ? 'em espera' : formatCallDuration(front.seconds)}
            </span>
          </div>
          <button
            onClick={() => toggleMute(front.key)}
            title={front.muted ? 'Ativar microfone' : 'Silenciar'}
            className={`flex size-8 items-center justify-center rounded-full transition ${
              front.muted
                ? 'bg-red-500 text-white'
                : 'bg-muted text-muted-foreground hover:bg-muted/70'
            }`}
          >
            {front.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
          </button>
          <button
            onClick={() => setMinimized(false)}
            title="Expandir"
            className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition hover:bg-muted/70"
          >
            <Maximize2 className="size-4" />
          </button>
          <button
            onClick={() => hangup(front.key)}
            title="Desligar"
            className="flex size-8 items-center justify-center rounded-full bg-red-500 text-white transition hover:bg-red-600"
          >
            <PhoneOff className="size-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-xs">
        {legStack}
        <div className="relative rounded-2xl border border-border bg-card p-6 text-center shadow-2xl">
          {front.phase === 'active' && (
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
              front.phase === 'permission'
                ? 'bg-amber-500/15 text-amber-600'
                : 'bg-primary/10 text-primary'
            }`}
          >
            {front.phase === 'permission' ? (
              <ShieldQuestion className="size-7" />
            ) : (
              <Phone className="size-7" />
            )}
          </div>
          <p className="mt-4 text-lg font-semibold text-foreground">
            {who(front)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{statusText}</p>

          {front.phase === 'ringing' ? (
            <div className="mt-6 flex items-center justify-center gap-6">
              <button
                onClick={() => reject(front.key)}
                className="flex size-14 items-center justify-center rounded-full bg-red-500 text-white transition hover:bg-red-600"
                title="Recusar"
              >
                <PhoneOff className="size-6" />
              </button>
              <button
                onClick={() => toggleRingMute(front.key)}
                className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground transition hover:bg-muted/70"
                title={front.ringMuted ? 'Voltar a tocar' : 'Silenciar o toque'}
              >
                {front.ringMuted ? (
                  <BellOff className="size-5" />
                ) : (
                  <Bell className="size-5" />
                )}
              </button>
              <button
                onClick={() => answer(front.key)}
                className="flex size-14 items-center justify-center rounded-full bg-emerald-500 text-white transition hover:bg-emerald-600"
                title="Atender"
              >
                <Phone className="size-6" />
              </button>
            </div>
          ) : front.phase === 'permission' ? (
            <div className="mt-6 flex flex-col items-center gap-3">
              <p className="text-xs text-muted-foreground">
                O WhatsApp exige que o cliente autorize antes de você ligar.
                Envie o pedido de permissão — ele aceita na conversa e depois
                você liga.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => closeLeg(front.key)}
                  className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => requestPermission(front.key)}
                  className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Pedir permissão
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-6 flex items-center justify-center gap-6">
              {frontHeld ? (
                // A parked leg in the foreground needs its own way back —
                // without this the agent can only resume it by first
                // activating some other leg to push this one into the stack.
                <button
                  onClick={() => activate(front.key)}
                  className="flex size-12 items-center justify-center rounded-full bg-emerald-500 text-white transition hover:bg-emerald-600"
                  title="Retomar esta ligação"
                >
                  <Phone className="size-5" />
                </button>
              ) : (
                <button
                  onClick={() => toggleMute(front.key)}
                  className={`flex size-12 items-center justify-center rounded-full transition ${
                    front.muted
                      ? 'bg-red-500 text-white hover:bg-red-600'
                      : 'bg-muted text-muted-foreground hover:bg-muted/70'
                  }`}
                  title={front.muted ? 'Ativar microfone' : 'Silenciar'}
                >
                  {front.muted ? (
                    <MicOff className="size-5" />
                  ) : (
                    <Mic className="size-5" />
                  )}
                </button>
              )}
              <button
                onClick={() => hangup(front.key)}
                className="flex size-14 items-center justify-center rounded-full bg-red-500 text-white transition hover:bg-red-600"
                title="Desligar"
              >
                <PhoneOff className="size-6" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
