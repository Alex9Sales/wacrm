'use client';

// ============================================================
// "Ligações" — WhatsApp-style call history panel. Lists every call on any
// transport (waha-voip / Meta): who, direction (recebida/efetuada/perdida),
// channel, when, duration — and click-to-call-back on WAHA channels. Missed
// calls stop vanishing into the ether (the ring-only modal was the sole
// trace before this).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  RefreshCw,
} from 'lucide-react';

import { startOutboundCall } from '@/components/calls/incoming-call-modal';
import { useServerEvents } from '@/hooks/use-server-events';
import { formatCallDuration } from '@/lib/inbox/call-log';

interface CallRow {
  id: string;
  peer: string;
  direction: 'in' | 'out';
  status: 'missed' | 'answered' | 'rejected' | 'dialing';
  provider: string;
  durationSec: number | null;
  createdAt: string;
  channelId: string | null;
  channelName: string | null;
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  conversationId: string | null;
}

function displayPeer(c: CallRow): string {
  if (c.contactName) return c.contactName;
  if (c.contactPhone) return c.contactPhone;
  if (/@(c\.us|s\.whatsapp\.net)$/.test(c.peer)) return c.peer.split('@')[0].split(':')[0];
  if (/@lid$/.test(c.peer)) return 'WhatsApp';
  return c.peer || '—';
}

function whenLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = d.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (sameDay) return time;
  if (d.toDateString() === yesterday.toDateString()) return `Ontem ${time}`;
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${time}`;
}

export default function CallsPage() {
  const router = useRouter();
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/calls/history');
      const data = (await res.json().catch(() => ({}))) as {
        calls?: CallRow[];
      };
      if (res.ok && data.calls) setCalls(data.calls);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live: a new incoming ring or a status flip re-fetches the list.
  const onEvent = useCallback(
    (e: { type: string }) => {
      if (e.type === 'call_incoming' || e.type === 'call_status') void load();
    },
    [load],
  );
  useServerEvents(onEvent);

  const callBack = (c: CallRow) => {
    const phone =
      c.contactPhone ||
      (/@(c\.us|s\.whatsapp\.net)$/.test(c.peer) ? c.peer.split('@')[0].split(':')[0] : '');
    if (!phone || !c.channelId) return;
    startOutboundCall(
      phone,
      c.contactName ?? undefined,
      'waha',
      undefined,
      c.channelId,
    );
  };

  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">Ligações</h1>
        <button
          onClick={() => {
            setLoading(true);
            void load();
          }}
          title="Atualizar"
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted"
        >
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {loading && calls.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          Carregando…
        </p>
      ) : calls.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
          <Phone className="size-8" />
          <p className="text-sm">Nenhuma ligação ainda.</p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {calls.map((c) => {
            const missed = c.status === 'missed' || c.status === 'rejected';
            const Icon =
              c.direction === 'out'
                ? PhoneOutgoing
                : missed
                  ? PhoneMissed
                  : PhoneIncoming;
            const statusLabel =
              c.direction === 'out'
                ? c.status === 'answered'
                  ? `Efetuada${c.durationSec ? ` • ${formatCallDuration(c.durationSec)}` : ''}`
                  : c.status === 'dialing'
                    ? 'Efetuada'
                    : 'Não atendida'
                : c.status === 'answered'
                  ? 'Recebida'
                  : c.status === 'rejected'
                    ? 'Recusada'
                    : 'Perdida';
            const canCallBack =
              !!c.channelId &&
              (!!c.contactPhone ||
                /@(c\.us|s\.whatsapp\.net)$/.test(c.peer));
            const openConversation = c.conversationId
              ? () => router.push(`/inbox?c=${c.conversationId}`)
              : undefined;
            return (
              <li
                key={c.id}
                onClick={openConversation}
                className={`flex items-center gap-3 px-4 py-3 ${
                  openConversation ? 'cursor-pointer hover:bg-muted/50' : ''
                }`}
              >
                <span
                  className={`flex size-10 shrink-0 items-center justify-center rounded-full ${
                    missed
                      ? 'bg-red-500/15 text-red-500'
                      : 'bg-emerald-500/15 text-emerald-600'
                  }`}
                >
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate text-sm font-medium ${
                      missed ? 'text-red-500' : 'text-foreground'
                    }`}
                  >
                    {displayPeer(c)}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {statusLabel}
                    {c.channelName ? ` • ${c.channelName}` : ''}
                  </p>
                </div>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {whenLabel(c.createdAt)}
                </span>
                {canCallBack && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      callBack(c);
                    }}
                    title="Ligar de volta"
                    className="flex size-8 shrink-0 items-center justify-center rounded-full text-emerald-600 transition hover:bg-emerald-500/10"
                  >
                    <PhoneCall className="size-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
