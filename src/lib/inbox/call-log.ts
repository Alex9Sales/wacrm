// ============================================================
// Call-log marker for the message thread. The messages table has a fixed
// content_type CHECK (no 'call'), so — like the Pix card — we store the call
// as a plain 'text' message whose body starts with CALL_LOG_PREFIX, and the
// bubble renders a WhatsApp-style call entry instead of a chat bubble.
// Shared by the webhook (writes) and message-bubble (reads).
// ============================================================

export const CALL_LOG_PREFIX = '⁣call⁣'; // invisible sentinel

/** Encode a finished call into a thread message body. */
export function buildCallLog(opts: {
  answered: boolean;
  durationSec?: number;
}): string {
  return opts.answered
    ? `${CALL_LOG_PREFIX}answered:${Math.max(0, Math.round(opts.durationSec ?? 0))}`
    : `${CALL_LOG_PREFIX}missed`;
}

export interface ParsedCallLog {
  answered: boolean;
  durationSec: number;
}

/** Parse a thread message body; null if it isn't a call-log marker. */
export function parseCallLog(text: string | null | undefined): ParsedCallLog | null {
  if (!text || !text.startsWith(CALL_LOG_PREFIX)) return null;
  const rest = text.slice(CALL_LOG_PREFIX.length);
  const m = rest.match(/^answered:(\d+)$/);
  if (m) return { answered: true, durationSec: parseInt(m[1], 10) };
  return { answered: false, durationSec: 0 };
}

/** m:ss */
export function formatCallDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
