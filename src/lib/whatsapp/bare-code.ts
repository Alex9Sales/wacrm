// ============================================================
// Mensagem que é SÓ um código — Pix copia-e-cola, linha digitável de boleto,
// link. Nela a assinatura do atendente ("*Leonardo Financeiro:*") vira lixo
// dentro do que o cliente copia: no celular ele segura a bolha, copia tudo e o
// app do banco recusa (10/09, Leonardo/GoLink cobrando recarga do Google Ads).
// A assinatura fica pras mensagens de gente; código sai limpo.
// ============================================================

/** Pix EMV (copia e cola): abre com 000201, tem o GUI do Bacen, fecha com 6304 + CRC16. */
const PIX_RE = /^000201[\s\S]{20,}6304[0-9A-Fa-f]{4}$/
const PIX_GUI_RE = /br\.gov\.bcb\.pix/i
/** Só dígitos com separadores (ponto/espaço/hífen): boleto (47) e convênio (48). */
const DIGITS_ONLY_RE = /^[\d][\d.\s-]*$/
const URL_RE = /^https?:\/\/\S+$/i

/** Verdadeiro quando a mensagem inteira é um código/link — não assine. */
export function looksLikeBareCode(text: string | null | undefined): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  if (URL_RE.test(t)) return true
  if (PIX_RE.test(t) && PIX_GUI_RE.test(t)) return true
  if (DIGITS_ONLY_RE.test(t)) {
    const digits = t.replace(/\D/g, '').length
    return digits >= 44 && digits <= 48
  }
  return false
}
