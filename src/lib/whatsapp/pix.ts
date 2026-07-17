// ============================================================
// Format a channel's saved Pix key as an outbound WhatsApp text message.
//
// The non-official engine (gows) has NO endpoint to send the native Pix
// payment card, so we send a copyable text block instead — same shape the
// inbound parser produces for a received Pix card, so a sent key reads like a
// received one and the customer can long-press to copy.
// ============================================================

/** Header for a Pix key block. MUST match the inbound parser's prefix
 *  (waha.ts imports this) so sent and received Pix render identically. */
export const PIX_PREFIX = '💠 Chave Pix';

export interface PixKey {
  key: string;
  /** CNPJ / CPF / E-mail / Telefone / Aleatória — free-form label. */
  keyType?: string;
  /** Account holder / merchant name. */
  name?: string;
}

/** Build the copyable message. Returns null when there's no key to send. */
export function formatPixMessage(pix: PixKey): string | null {
  const key = pix.key?.trim();
  if (!key) return null;
  const kt = pix.keyType?.trim() ? ` • ${pix.keyType.trim()}` : '';
  const name = pix.name?.trim() ? `\n${pix.name.trim()}` : '';
  return `${PIX_PREFIX}${kt}${name}\n${key}`;
}
