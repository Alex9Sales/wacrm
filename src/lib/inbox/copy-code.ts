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

  // Pix copia e cola — a mensagem inteira tem que SER o BR Code: começa em
  // 000201, termina no CRC (6304 + 4 hex) e traz o domínio do Pix. Texto que só
  // CONTÉM um Pix ("Segue o Pix: 000201…\nVence dia 20") continua texto — o
  // cartão escondia o resto (mesmo defeito do cartão de localização, 16/09).
  // Só quebras de linha saem: o espaço no nome/cidade do recebedor FAZ PARTE do
  // código (tamanho do campo e CRC) — sem ele o banco recusa o Pix copiado.
  const pix = t.replace(/[\r\n]+/g, '');
  if (/^000201\S[\s\S]{20,}6304[0-9A-Fa-f]{4}$/.test(pix) && /br\.gov\.bcb\.pix/i.test(pix)) {
    return { label: 'Pix copia e cola', code: pix };
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
