'use client';

// ============================================================
// Live monitor of the AI voice calls (IA de voz — fatia 5, parte A). Subscribes
// to the account SSE stream and renders each active call with its transcript
// streaming in real time (🤖 IA / 🗣️ cliente), as the bridge posts each line
// to /api/internal/voice-live. Read-only for now; handoff comes later.
// ============================================================

import { useEffect, useRef, useState } from 'react';
import { Phone, Radio } from 'lucide-react';

import { useServerEvents, type ServerEvent } from '@/hooks/use-server-events';
import { takeOverVoiceCall } from '@/components/calls/incoming-call-modal';
import { VOICE_HANDOFF_ENABLED } from '@/lib/calls/handoff';

interface Line {
  role: 'ai' | 'customer';
  text: string;
  ts: number;
}
interface LiveCall {
  callId: string;
  channelName?: string;
  channelId?: string;
  from?: string;
  callerName?: string;
  lines: Line[];
  ended: boolean;
}

export function VoiceMonitor() {
  const [calls, setCalls] = useState<Record<string, LiveCall>>({});

  useServerEvents((e: ServerEvent) => {
    if (e.type !== 'voice_live') return;
    const ev = e as ServerEvent & {
      callId: string;
      phase: 'start' | 'line' | 'end';
      channelName?: string;
      channelId?: string;
      from?: string;
      callerName?: string;
      role?: 'ai' | 'customer';
      text?: string;
      ts?: number;
    };
    setCalls((prev) => {
      const next = { ...prev };
      const cur = next[ev.callId] ?? {
        callId: ev.callId,
        lines: [],
        ended: false,
      };
      if (ev.phase === 'start') {
        next[ev.callId] = {
          ...cur,
          channelName: ev.channelName ?? cur.channelName,
          channelId: ev.channelId ?? cur.channelId,
          from: ev.from ?? cur.from,
          callerName: ev.callerName ?? cur.callerName,
          ended: false,
        };
      } else if (ev.phase === 'line' && ev.role && ev.text) {
        // Sort by turn-start ts so a late-arriving customer line lands in
        // order (the customer's STT completes after the AI already replied).
        const lines = [
          ...cur.lines,
          { role: ev.role, text: ev.text, ts: ev.ts ?? Date.now() },
        ].sort((a, b) => a.ts - b.ts);
        next[ev.callId] = {
          ...cur,
          channelName: ev.channelName ?? cur.channelName,
          channelId: ev.channelId ?? cur.channelId,
          lines,
        };
      } else if (ev.phase === 'end') {
        next[ev.callId] = { ...cur, ended: true };
        // Drop the finished call from the board a bit later.
        setTimeout(() => {
          setCalls((p) => {
            const n = { ...p };
            delete n[ev.callId];
            return n;
          });
        }, 20000);
      }
      return next;
    });
  });

  const active = Object.values(calls);

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Radio className="size-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">
          Ligações da IA — ao vivo
        </h2>
        {active.length > 0 && (
          <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500 text-[11px] font-bold text-white">
            {active.length}
          </span>
        )}
      </div>

      {active.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Nenhuma ligação da IA no momento. Quando a IA de voz atender, a
          conversa aparece aqui em tempo real.
        </p>
      ) : (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {active.map((c) => (
            <LiveCallCard key={c.callId} call={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function LiveCallCard({ call }: { call: LiveCall }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [call.lines.length]);

  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Phone className="size-3.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {call.callerName || call.from || 'Ligação'}
            </p>
            {call.channelName && (
              <p className="truncate text-[11px] text-muted-foreground">
                {call.channelName}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {VOICE_HANDOFF_ENABLED && !call.ended && (
            <button
              type="button"
              onClick={() =>
                takeOverVoiceCall(
                  call.callId,
                  call.channelId,
                  call.from,
                  call.callerName,
                )
              }
              className="flex items-center gap-1 rounded-full bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-emerald-700"
              title="Assumir a ligação — a IA se despede e te passa a chamada"
            >
              <Phone className="size-3" />
              Assumir
            </button>
          )}
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
              call.ended
                ? 'bg-muted text-muted-foreground'
                : 'bg-emerald-500/15 text-emerald-600'
            }`}
          >
            {call.ended ? 'encerrada' : '● ao vivo'}
          </span>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="mt-2 max-h-56 space-y-1.5 overflow-y-auto pr-1"
      >
        {call.lines.length === 0 ? (
          <p className="text-xs text-muted-foreground">conectando…</p>
        ) : (
          call.lines.map((l, i) => (
            <div key={i} className="text-xs leading-snug">
              <span className={l.role === 'ai' ? 'text-primary' : 'text-foreground'}>
                {l.role === 'ai' ? '🤖 ' : '🗣️ '}
              </span>
              <span className="text-foreground">{l.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
