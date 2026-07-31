/**
 * Sanitize phone number for Meta WhatsApp API.
 * Meta requires digits only — no + prefix, no spaces, no dashes.
 * e.g. "+370 63949836" → "37063949836"
 */
export function sanitizePhoneForMeta(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Normalize phone number by removing all non-digit characters.
 * Used for comparing phone numbers in different formats.
 */
export function normalizePhone(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Compare two phone numbers accounting for trunk prefix differences.
 * e.g. "370063949836" (with trunk 0) matches "37063949836" (without trunk 0)
 * by comparing the last 8 digits.
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  const n1 = normalizePhone(phone1)
  const n2 = normalizePhone(phone2)
  if (n1 === n2) return true
  if (n1.length >= 8 && n2.length >= 8) {
    return n1.slice(-8) === n2.slice(-8)
  }
  return false
}

/**
 * Validate phone number is E.164-like format (7-15 digits starting with non-zero).
 * Accepts with or without + prefix.
 */
export function isValidE164(phone: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(phone)
}

/** Brazilian carrier-selection codes (CSP) seen prefixed onto national-dialed
 *  numbers ("0 + CSP + DDD + número"). Used to tell a CSP apart from a DDD when
 *  the digit count is ambiguous. Not exhaustive — just the common operators. */
const BR_CSP = new Set(['12', '14', '15', '17', '21', '23', '25', '31', '32', '41', '43'])

/** A plausible Brazilian area code (DDD): 11–99, first digit non-zero. */
function isPlausibleDDD(dd: string): boolean {
  const n = Number(dd)
  return Number.isInteger(n) && n >= 11 && n <= 99
}

/**
 * Normalize an inbound WhatsApp phone to E.164 digits, fixing the Brazilian
 * national-dialing artifacts some engines (gows/NOWEB) deliver: a leading trunk
 * `0`, and the long-distance "0 + carrier-selection-code + DDD + number" format.
 *
 * SAFE BY DESIGN: only acts when the number starts with `0`. A leading `0` is
 * never valid in E.164, so a clean international number — INCLUDING any 55… BR
 * number that already works — is returned untouched and can never be corrupted.
 * Idempotent.
 *
 *   "01527999438466" (0 + CSP 15 + DDD 27 + 999438466) → "5527999438466"
 *   "027999438466"   (0 + DDD 27 + 999438466)          → "5527999438466"
 *   "5527999438466"  (already E.164)                    → "5527999438466" (untouched)
 *   "+1 202 555 0181"                                   → "12025550181" (untouched)
 */
export function normalizeInboundPhoneBR(raw: string): string {
  const digits = (raw || '').replace(/\D/g, '')
  // Clean numbers (no trunk 0) are already E.164-shaped — never touch them.
  if (!digits || digits[0] !== '0') return digits
  const d = digits.replace(/^0+/, '') // strip the trunk zero(s)
  if (d.startsWith('55')) return d // "0 + 55…" already carries the country code
  // National number reached with the trunk 0:
  //   10–11 digits = DDD(2) + local(8–9)          → just prefix 55
  if ((d.length === 10 || d.length === 11) && isPlausibleDDD(d.slice(0, 2))) {
    return '55' + d
  }
  //   12–13 digits = CSP(2) + DDD(2) + local(8–9) → drop the CSP, prefix 55.
  //   Gated on a known CSP + a plausible DDD so a foreign 0-prefixed number
  //   isn't mangled into a fake BR one.
  if (d.length === 12 || d.length === 13) {
    const csp = d.slice(0, 2)
    const rest = d.slice(2)
    if (BR_CSP.has(csp) && isPlausibleDDD(rest.slice(0, 2))) {
      return '55' + rest
    }
  }
  return d // fallback: at least the leading zeros are gone
}

/**
 * Generate plausible phone number variants for retry when Meta's
 * sandbox rejects a number with error #131030 ("not in allowed list").
 *
 * Many countries use a "trunk prefix" 0 for domestic dialing that is
 * meant to be dropped in international format (e.g. Lithuanian
 * "+370 063 949 836" domestically → "+370 63 949 836" international).
 * But some sandboxes register the number with the trunk 0 included,
 * causing sends to the correct international format to fail.
 *
 * This helper yields up to 3 variants:
 *   1. The original sanitized number (first attempt)
 *   2. With a trunk 0 inserted after the country code
 *   3. With a trunk 0 removed after the country code
 *
 * Country-code lengths of 1, 2, and 3 digits are tried because we
 * don't know the user's country ahead of time.
 *
 * @param sanitized - digits-only phone number (from sanitizePhoneForMeta)
 * @returns deduplicated list of variants, original first
 */
export function phoneVariants(sanitized: string): string[] {
  if (!sanitized) return []
  const seen = new Set<string>()
  const push = (v: string) => {
    if (v && !seen.has(v)) seen.add(v)
  }

  // 1. Original
  push(sanitized)

  // 2. Insert a 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (!rest.startsWith('0')) {
      push(cc + '0' + rest)
    }
  }

  // 3. Remove a leading 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen + 1) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (rest.startsWith('0')) {
      push(cc + rest.slice(1))
    }
  }

  return [...seen]
}

/**
 * Returns true when the Meta API error indicates the recipient
 * phone number isn't in the allowed list (sandbox restriction).
 * Detected via error code 131030 or the standard error text.
 */
export function isRecipientNotAllowedError(message: string): boolean {
  return /131030|not in allowed list|not in the allowed list/i.test(message)
}
