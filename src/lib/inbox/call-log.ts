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

// ---- call permission (customer authorised the business to call) ----

export const CALL_PERM_PREFIX = '⁣callperm⁣';

/** Encode a call_permission_reply into a thread message body. */
export function buildCallPermission(opts: {
  granted: boolean;
  permanent: boolean;
  expirationTs?: number;
}): string {
  const g = opts.granted ? '1' : '0';
  const p = opts.permanent ? 'p' : 't';
  return `${CALL_PERM_PREFIX}${g}:${p}:${opts.expirationTs ?? 0}`;
}

export interface ParsedCallPermission {
  granted: boolean;
  permanent: boolean;
  expiresAt: number; // epoch seconds; 0 when none
}

export function parseCallPermission(
  text: string | null | undefined,
): ParsedCallPermission | null {
  if (!text || !text.startsWith(CALL_PERM_PREFIX)) return null;
  const m = text.slice(CALL_PERM_PREFIX.length).match(/^([01]):([pt]):(\d+)$/);
  if (!m) return null;
  return {
    granted: m[1] === '1',
    permanent: m[2] === 'p',
    expiresAt: parseInt(m[3], 10),
  };
}

/** DD/MM from epoch seconds. */
export function formatDayMonth(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}
