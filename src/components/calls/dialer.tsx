'use client';

// ============================================================
// Dialer — place a WhatsApp (waha-voip) call by typing the customer's number,
// no open conversation required. Opened from the "Ligações" panel header.
//
// On call: find-or-create the conversation for that number FIRST (so the agent
// can drop a Pix / payment link right after hanging up — the thread is already
// there), then startOutboundCall through the chosen channel, then jump into the
// conversation. The waha initiate route resolves the canonical chatId (the LID
// / 9th-digit fix), so we only send lightly-cleaned digits.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Phone, Delete, X } from 'lucide-react';
import { toast } from 'sonner';

import { startOutboundCall } from './incoming-call-modal';
import { formatDisplay, isDialable, toDialDigits } from './dialer-format';
import { listWahaChannels, type DialerChannel } from '@/app/(dashboard)/calls/actions';

// Digits only: a WhatsApp call has no DTMF, so *, # would be dead keys the
// number field silently drops. 0 sits centered on the last row.
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', ''];

export function Dialer({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [digits, setDigits] = useState('');
  const [channels, setChannels] = useState<DialerChannel[]>([]);
  const [channelId, setChannelId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listWahaChannels()
      .then((list) => {
        // Only channels that can actually place a call — a disconnected/error
        // channel in the picker just wastes the agent's click.
        const live = list.filter((c) => c.status === 'connected');
        setChannels(live);
        if (live.length > 0) setChannelId(live[0].id);
      })
      .catch(() => {
        // Non-fatal: leave the picker empty; call() guards on channelId.
      });
  }, []);

  const press = useCallback((k: string) => setDigits((d) => d + k), []);
  const backspace = useCallback(() => setDigits((d) => d.slice(0, -1)), []);

  // Hardware keyboard: type the number, Backspace to delete, Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Backspace') {
        setDigits((d) => d.slice(0, -1));
      } else if (/^[0-9]$/.test(e.key)) {
        setDigits((d) => d + e.key);
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    // Paste a number from anywhere (a spreadsheet, a chat): keep its digits.
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text') ?? '';
      const d = text.replace(/\D/g, '');
      if (d) setDigits((cur) => cur + d);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('paste', onPaste);
    };
  }, [onClose]);

  const call = useCallback(async () => {
    if (busy) return;
    if (!isDialable(digits)) {
      toast.error('Número incompleto. Digite DDD + número.');
      return;
    }
    const to = toDialDigits(digits);
    if (!channelId) {
      toast.error('Nenhum canal de WhatsApp disponível para ligar.');
      return;
    }
    setBusy(true);
    try {
      // Find-or-create the conversation first, so it's ready for a follow-up
      // message (Pix, link) right after the call.
      const res = await fetch('/api/conversations/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: to, channelId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        conversationId?: string;
      };
      const conversationId = res.ok ? data.conversationId : undefined;
      startOutboundCall(to, undefined, 'waha', conversationId, channelId);
      onClose();
      if (conversationId) router.push(`/inbox?c=${conversationId}`);
    } catch {
      // The call itself can still go through even if the conversation resolve
      // failed — place it without a thread rather than blocking the agent.
      startOutboundCall(to, undefined, 'waha', undefined, channelId);
      onClose();
    } finally {
      setBusy(false);
    }
  }, [busy, digits, channelId, router, onClose]);

  const display = formatDisplay(digits);

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/50 p-4">
      <div className="relative w-full max-w-[17rem] rounded-2xl border border-border bg-card p-5 shadow-2xl">
        <button
          onClick={onClose}
          title="Fechar"
          className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted"
        >
          <X className="size-4" />
        </button>

        <p className="mb-1 text-center text-xs font-medium text-muted-foreground">
          Nova ligação
        </p>

        {/* Number display. Font shrinks as the number grows so the full
            number always fits (no truncation) — a dialer that hides the last
            digits you typed is worse than a slightly smaller font. */}
        <div className="mb-3 flex min-h-[2.5rem] items-center justify-center px-1">
          {digits ? (
            <span
              className={`whitespace-nowrap text-center font-semibold tabular-nums text-foreground ${
                display.length > 17
                  ? 'text-base'
                  : display.length > 14
                    ? 'text-lg'
                    : 'text-xl'
              }`}
            >
              {display}
            </span>
          ) : (
            <span className="text-xl text-muted-foreground">Digite o número</span>
          )}
        </div>

        {/* Channel picker — hidden when there's only one channel. */}
        {channels.length > 1 && (
          <select
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            className="mb-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
          >
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}

        {/* Keypad */}
        <div className="grid grid-cols-3 gap-2">
          {KEYS.map((k, i) =>
            k ? (
              <button
                key={i}
                onClick={() => press(k)}
                className="flex h-12 items-center justify-center rounded-xl bg-muted text-lg font-medium text-foreground transition hover:bg-muted/70 active:scale-95"
              >
                {k}
              </button>
            ) : (
              <div key={i} aria-hidden />
            ),
          )}
        </div>

        {/* Actions */}
        <div className="mt-3 flex items-center justify-center gap-4">
          <div className="size-12" aria-hidden />
          <button
            onClick={call}
            disabled={busy || !digits}
            title="Ligar"
            className="flex size-14 items-center justify-center rounded-full bg-emerald-500 text-white transition hover:bg-emerald-600 disabled:opacity-40"
          >
            <Phone className="size-6" />
          </button>
          <button
            onClick={backspace}
            disabled={!digits}
            title="Apagar"
            className="flex size-12 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted disabled:opacity-30"
          >
            <Delete className="size-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
