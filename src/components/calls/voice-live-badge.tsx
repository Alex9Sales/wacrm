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
import { Bot } from 'lucide-react';

import { useServerEvents, type ServerEvent } from '@/hooks/use-server-events';

interface ActiveCall {
  channelName?: string;
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
      from?: string;
      callerName?: string;
    };
    setCalls((prev) => {
      const next = { ...prev };
      if (ev.phase === 'start') {
        next[ev.callId] = {
          channelName: ev.channelName,
          from: ev.from,
          callerName: ev.callerName,
        };
      } else if (ev.phase === 'end') {
        delete next[ev.callId];
      } else if (ev.phase === 'line' && !next[ev.callId]) {
        // Missed the 'start' (page opened mid-call) — show it anyway.
        next[ev.callId] = { channelName: ev.channelName };
      }
      return next;
    });
  });

  const active = Object.values(calls);
  if (active.length === 0) return null;

  const first = active[0];
  const label =
    active.length === 1
      ? first.callerName || first.from || 'ligação'
      : `${active.length} ligações`;

  return (
    <Link
      href="/supervisao"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg transition hover:bg-emerald-700"
      title="Ver no monitor ao vivo (Supervisão)"
    >
      <span className="relative flex size-2.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-white opacity-75" />
        <span className="relative inline-flex size-2.5 rounded-full bg-white" />
      </span>
      <Bot className="size-4" />
      <span>
        IA em atendimento — <span className="font-semibold">{label}</span>
        {active.length === 1 && first.channelName ? ` · ${first.channelName}` : ''}
      </span>
    </Link>
  );
}
