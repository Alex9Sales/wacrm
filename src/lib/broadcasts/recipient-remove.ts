// ============================================================
// Tirar UM destinatário de um disparo que ainda não mandou pra ele.
//
// 15/09 (GoLink): pra tirar 2 pessoas da fila (já tinham recebido à mão), a
// única saída era cancelar e refazer o disparo inteiro — o que gerou envios
// repetidos. CONTRATO (base comum) — implementação na frente "fila".
// ============================================================

export type RemoveRecipientResult = { ok: true } | { ok: false; error: string }

export async function removePendingRecipient(
  _accountId: string,
  _broadcastId: string,
  _recipientId: string,
): Promise<RemoveRecipientResult> {
  return { ok: false, error: 'Ainda não disponível.' }
}
