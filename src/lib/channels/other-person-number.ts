// ============================================================
// 📱 "Você está respondendo pelo número de outra pessoa."
//
// 14/09 (João/GoLink): o cliente escreveu pro número do Vitor, o Vitor
// transferiu a conversa pro João, e o João respondeu pelo CRM — a mensagem
// saiu pelo WhatsApp do Vitor e ele foi procurar no próprio celular. Transferir
// muda QUEM atende, não POR QUAL NÚMERO sai. O aviso aparece quando o número da
// conversa é dedicado a outra pessoa. Número comum da empresa (sem dono) não
// avisa: todo mundo responde por ele de propósito.
//
// Puro (client-safe).
// ============================================================

import { formatPhone } from '@/lib/format-phone'

const WHATSAPP = new Set(['meta', 'waha', 'evolution', 'evogo'])

export interface OtherPersonNumber {
  /** Nome do canal, como aparece no seletor de números. */
  name: string
  /** Telefone formatado ("+55 12 99230-6060"), quando conhecido. */
  phone: string | null
}

export function otherPersonNumber(
  channel: { provider: string; name: string; phone_number?: string | null; dedicated_user_id?: string | null } | null | undefined,
  userId: string | null | undefined,
): OtherPersonNumber | null {
  if (!channel || !userId) return null
  if (!WHATSAPP.has(channel.provider)) return null
  if (!channel.dedicated_user_id || channel.dedicated_user_id === userId) return null
  const phone = channel.phone_number?.replace(/\D/g, '') ? formatPhone(channel.phone_number) : null
  return { name: channel.name?.trim() || 'deste canal', phone }
}
