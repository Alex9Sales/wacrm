'use client';

// ============================================================
// Global "IA em atendimento" indicator (IA de voz — fatia 5A). A floating pill
// that appears on ANY page while the AI voice agent is on a call, so an operator
// knows the call is being handled (the ringing modal already stood down when
// the AI took it). Clicking opens the Supervisão live monitor. Driven by the
// 'voice_live' SSE events (phase start/end).
// ============================================================

import { useState } from 'react';
import Link from 'next/link';
import { Bot, Phone } from 'lucide-react';

import { useServerEvents, type ServerEvent } from '@/hooks/use-server-events';
import { takeOverVoiceCall } from './incoming-call-modal';
import { VOICE_HANDOFF_ENABLED } from '@/lib/calls/handoff';

interface ActiveCall {
  channelName?: string;
  channelId?: string;
  from?: string;
  callerName?: string;
}

export function VoiceLiveBadge() {
  const [calls, setCalls] = useState<Record<string, ActiveCall>>({});

  useServerEvents((e: ServerEvent) => {
    if (e.type !== 'voice_live') return;
    const ev = e as ServerEvent & {
      callId: string;
      phase: 'start' | 'line' | 'end';
      channelName?: string;
      channelId?: string;
      from?: string;
      callerName?: string;
    };
    setCalls((prev) => {
      const next = { ...prev };
      if (ev.phase === 'start') {
        next[ev.callId] = {
          channelName: ev.channelName,
          channelId: ev.channelId,
          from: ev.from,
          callerName: ev.callerName,
        };
      } else if (ev.phase === 'end') {
        delete next[ev.callId];
      } else if (ev.phase === 'line' && !next[ev.callId]) {
        // Missed the 'start' (page opened mid-call) — show it anyway.
        next[ev.callId] = { channelName: ev.channelName, channelId: ev.channelId };
      }
      return next;
    });
  });

  const entries = Object.entries(calls);
  if (entries.length === 0) return null;

  const [firstId, first] = entries[0];
  const label =
    entries.length === 1
      ? first.callerName || first.from || 'ligação'
      : `${entries.length} ligações`;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2">
      <Link
        href="/supervisao"
        className="flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg transition hover:bg-emerald-700"
        title="Ver no monitor ao vivo (Supervisão)"
      >
        <span className="relative flex size-2.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-white opacity-75" />
          <span className="relative inline-flex size-2.5 rounded-full bg-white" />
        </span>
        <Bot className="size-4" />
        <span>
          IA em atendimento — <span className="font-semibold">{label}</span>
          {entries.length === 1 && first.channelName
            ? ` · ${first.channelName}`
            : ''}
        </span>
      </Link>
      {/* Single live AI call → one-click takeover. With several, the operator
          picks the specific call from the Supervisão monitor. */}
      {VOICE_HANDOFF_ENABLED && entries.length === 1 && (
        <button
          type="button"
          onClick={() =>
            takeOverVoiceCall(
              firstId,
              first.channelId,
              first.from,
              first.callerName,
            )
          }
          className="flex items-center gap-1.5 rounded-full bg-white px-3.5 py-2.5 text-sm font-semibold text-emerald-700 shadow-lg ring-1 ring-emerald-600/20 transition hover:bg-emerald-50"
          title="Assumir a ligação — a IA se despede e te passa a chamada"
        >
          <Phone className="size-4" />
          Assumir
        </button>
      )}
    </div>
  );
}
