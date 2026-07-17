// ============================================================
// Detect a long copyable code pasted as a plain-text message — a Pix "copia e
// cola" (BR Code / EMV payload) or a boleto barcode / linha digitável — so the
// bubble can render it as a compact copy card instead of a 150–200 char wall
// of text. Kept pure + tested: a wrong hit hides a normal message.
// ============================================================

export interface CopyCode {
  label: string;
  code: string;
}

export function detectCopyCode(txt: string): CopyCode | null {
  const t = (txt ?? '').trim();
  if (!t) return null;

  // Pix copia e cola — the BR Code payload carries this domain marker, unique
  // enough to key on. The payload is one unbroken string, so strip whitespace.
  if (/br\.gov\.bcb\.pix/i.test(t) && t.replace(/\s/g, '').length > 40) {
    return { label: 'Pix copia e cola', code: t.replace(/\s+/g, '') };
  }

  // Boleto — the message is ONLY digits/dots/spaces and normalizes to a
  // barcode (44) or linha digitável (47–48). The all-numeric guard keeps
  // ordinary messages that merely contain a long number from matching.
  if (/^[\d.\s]+$/.test(t)) {
    const digits = t.replace(/\D/g, '');
    if (digits.length === 44 || digits.length === 47 || digits.length === 48) {
      return { label: 'Código de barras', code: digits };
    }
  }

  return null;
}
