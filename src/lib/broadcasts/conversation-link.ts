// ============================================================
// Quem cria o disparo passa a ENXERGAR as conversas que ele gera.
//
// 15/09 (GoLink): cada envio cria a conversa no número do disparo, sem
// responsável; num número dedicado a outra pessoa, quem disparou não via
// nenhuma. Participante (conversation_participants) já vence a regra de canal
// dedicado na lista e na leitura (lib/sectors/access.ts) — sem trocar o
// responsável nem o número. CONTRATO (base comum) — implementação na frente
// "fila". Worker-safe (sem 'server-only').
// ============================================================

export async function linkBroadcastConversation(_input: {
  accountId: string
  channelId: string
  contactId: string
  creatorUserId: string
}): Promise<void> {}
