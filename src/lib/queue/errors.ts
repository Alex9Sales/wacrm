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
];

/** True when the error is permanent (mark failed, skip retries). */
export function isPermanentSendError(message: string): boolean {
  return PERMANENT_PATTERNS.some((re) => re.test(message));
}
