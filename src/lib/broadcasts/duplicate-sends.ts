// ============================================================
// Quem JÁ recebeu esta mesma mensagem hoje — pra não mandar 2×.
//
// 15/09 (GoLink): o Vitor refez o "dia do cliente" 3 vezes (outro número,
// imagem subida de novo) e Flash Baterias, Piso Decor e Vidro e Cia
// receberam a mesma imagem 2×; outros já tinham recebido à mão.
//
// CONTRATO (base comum) — implementação na frente "fila".
// Worker-safe (sem 'server-only').
// ============================================================

export interface DuplicateSkip {
  contactId: string
  name: string | null
  /** Quando recebeu a mesma mensagem (ISO). */
  lastSentAt: string
}

export interface BroadcastContentFingerprint {
  bodyText: string | null
  /** Nomes dos arquivos anexados (a URL muda a cada upload; o nome não). */
  mediaFilenames: string[]
  subject?: string | null
}

/**
 * Contatos (dentre `contactIds`) que receberam a mesma mensagem nas últimas
 * 24 h (padrão) por qualquer canal da conta — disparo ou envio manual.
 */
export async function findRecentDuplicateContacts(
  _accountId: string,
  _contactIds: readonly string[],
  _content: BroadcastContentFingerprint,
  _opts: { sinceMs?: number } = {},
): Promise<DuplicateSkip[]> {
  return []
}
