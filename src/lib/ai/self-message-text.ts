// ============================================================
// Parte PURA da checagem de "eco interno" (ver self-message.ts): como um
// texto vira uma impressão digital comparável entre o que o CRM ENVIOU e o
// que chegou como "mensagem do cliente" noutro canal.
//
// Sem imports de banco/Redis — importável por teste e por client.
// ============================================================

import { createHash } from 'crypto'

/**
 * Abaixo disso o casamento por texto no banco NÃO vale: "Ok", "Sim", "Bom dia"
 * saem de qualquer canal o tempo todo e casariam com cliente de verdade. O
 * marcador do Redis (gravado por quem envia) não tem esse piso — é exato.
 */
export const MIN_TEXT_FOR_DB_MATCH = 12

/** Colapsa espaços/quebras: o mesmo aviso chega com quebras diferentes
 *  dependendo do canal (Meta × WAHA) — a comparação tem que ignorar isso. */
export function normalizeSelfText(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

/** Impressão digital do texto normalizado — chave do marcador no Redis. */
export function selfMessageFingerprint(text: string): string {
  return createHash('sha1').update(normalizeSelfText(text)).digest('hex')
}
