// ============================================================
// Error classification for the recipient worker (Phase 5 CORE).
//
// A failed send is either:
//   permanent  → the message will NEVER succeed on retry (invalid
//                number, rejected/unknown template, unsupported op). Mark
//                the recipient 'failed' and do NOT retry.
//   transient  → a rate limit, timeout, 5xx, or network blip. Let BullMQ
//                retry with backoff.
//
// We match on the Meta/provider error text since the providers surface a
// plain Error(message). Conservative by design: unknown errors are
// treated as transient so a retry gets a chance rather than silently
// dropping a recipient — except we never loop forever (attempts cap).
// ============================================================

/** Substrings/codes that mean the send can never succeed on retry. */
const PERMANENT_PATTERNS: RegExp[] = [
  /invalid\s+(phone|number|recipient|wa_id)/i,
  /not a valid whatsapp number/i,
  /recipient phone number not.*valid/i,
  /template.*(not found|does not exist|rejected|not approved|paused|disabled)/i,
  /unknown template/i,
  /unsupported/i,
  /\b(?:132000|132001|132005|132007|132012|132015|132016|131008|131009|131026)\b/,
  // 131026 = message undeliverable; 131008/9 = required param missing.
  // GOWS/whatsmeow (waha-voip): 463 = WhatsApp's anti-spam block on cold/
  // unsolicited outbound (the number got flagged, or the recipient rejects
  // non-contacts). It won't clear on an immediate retry — retrying only
  // HAMMERS the sender number's reputation, so fail fast (no retry).
  /server returned error 463\b/i,
  /\berror 46[0-3]\b/i,
];

/** True when the error is permanent (mark failed, skip retries). */
export function isPermanentSendError(message: string): boolean {
  return PERMANENT_PATTERNS.some((re) => re.test(message));
}

// ------------------------------------------------------------
// Channel-level trouble → stop the WHOLE broadcast, not just this recipient
// ------------------------------------------------------------
//
// Some failures aren't about the recipient at all — the SENDING CHANNEL is in
// trouble, so every remaining recipient will fail too, and pushing on makes it
// worse:
//   * reputation (463): WhatsApp is throttling/blocking the number for
//     spam-like sending. Each extra attempt digs the hole deeper and walks
//     toward a permanent ban.
//   * session_down: the session logged out / the device was removed / it isn't
//     WORKING. Nothing can go out until it's reconnected; grinding on just
//     marks everyone 'failed' (and each attempt burns ~30s in timeouts).
// Both mean: pause the broadcast and tell a human. Real case (22-23/07): a cold
// 50-message blast got the device removed, then every send came back 463.

export type ChannelHaltReason = 'reputation' | 'session_down';

const REPUTATION_PATTERNS: RegExp[] = [
  /server returned error 463\b/i,
  /\berror 46[0-3]\b/i,
];

const SESSION_DOWN_PATTERNS: RegExp[] = [
  /session status is not as expected/i,
  /logged\s*out/i,
  /device removed/i,
  /session (?:not found|is not running|stopped|failed)/i,
  /\b(?:SCAN_QR|STARTING|STOPPED)\b/,
];

/**
 * Why the whole broadcast should stop, or null when the failure is just this
 * recipient's problem (bad number, etc.).
 */
export function channelHaltReason(message: string): ChannelHaltReason | null {
  if (REPUTATION_PATTERNS.some((re) => re.test(message))) return 'reputation';
  if (SESSION_DOWN_PATTERNS.some((re) => re.test(message))) return 'session_down';
  return null;
}
