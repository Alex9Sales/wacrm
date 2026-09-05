// ============================================================
// 🧾 Alcançar o devedor que NUNCA conversou (gap nº1 do agente de cobrança).
//
// Até 05/09 a régua só enviava para quem já tinha conversa no CRM: numa
// carteira de inadimplentes isso é a minoria. Aqui a cobrança abre a conversa
// sozinha, no número que a conta escolheu para cobrar (ou no único número
// conectado — com mais de um, pedimos a escolha em vez de chutar de qual
// número o cliente vai receber uma cobrança).
//
// Sem 'server-only' — o executor roda no worker.
// ============================================================

import { and, eq, inArray } from 'drizzle-orm'

import { db, channels, contacts } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { ensureConversationForContact } from '@/lib/whatsapp/resolve-conversation'

import { normalizeSettings } from './rules'

/** Provedores que são WhatsApp — os únicos por onde a régua envia hoje. */
export const WHATSAPP_PROVIDERS = ['meta', 'waha', 'evolution', 'evogo'] as const

export type ChannelPick = { ok: true; id: string; name: string } | { ok: false; error: string }

/**
 * Qual número envia a cobrança. Explícito na configuração > único conectado.
 * Toda recusa vem com o caminho para resolver — é isso que aparece na fila.
 */
export async function pickCollectionChannel(accountId: string, channelId: string | null): Promise<ChannelPick> {
  const rows = await db
    .select({ id: channels.id, name: channels.name, status: channels.status })
    .from(channels)
    .where(and(eq(channels.accountId, accountId), inArray(channels.provider, [...WHATSAPP_PROVIDERS])))

  if (channelId) {
    const chosen = rows.find((r) => r.id === channelId)
    if (!chosen) return { ok: false, error: 'O número escolhido para cobrar não existe mais nesta conta — escolha outro em Cobranças → Ajustar.' }
    if (chosen.status !== 'connected') {
      return { ok: false, error: `O número "${chosen.name}" está desconectado — reconecte ou escolha outro em Cobranças → Ajustar.` }
    }
    return { ok: true, id: chosen.id, name: chosen.name }
  }

  const connected = rows.filter((r) => r.status === 'connected')
  if (connected.length === 1) return { ok: true, id: connected[0].id, name: connected[0].name }
  if (!connected.length) return { ok: false, error: 'Nenhum número de WhatsApp conectado para enviar a cobrança.' }
  return { ok: false, error: 'Há mais de um número conectado: escolha em Cobranças → Ajustar qual deles envia as cobranças.' }
}

export type OpenOutcome =
  | { ok: true; conversationId: string; created: boolean; channelName: string }
  | { ok: false; error: string }

/**
 * Abre (ou reencontra) a conversa de cobrança de um contato no número da
 * régua. Chamado pelo executor só quando o devedor não tem conversa nenhuma.
 */
export async function openCollectionConversation(accountId: string, contactId: string): Promise<OpenOutcome> {
  const contact = firstOrNull(
    await db
      .select({ phone: contacts.phone })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
      .limit(1),
  )
  if (!contact) return { ok: false, error: 'Contato não encontrado.' }
  if (!(contact.phone ?? '').replace(/\D/g, '')) {
    return { ok: false, error: 'Este contato não tem telefone — não dá para abrir conversa no WhatsApp.' }
  }

  const settings = normalizeSettings((await getAccountSettings(accountId)).collections)
  const channel = await pickCollectionChannel(accountId, settings.channelId)
  if (!channel.ok) return channel

  try {
    const conv = await ensureConversationForContact(accountId, contactId, channel.id)
    return { ok: true, conversationId: conv.conversationId, created: conv.created, channelName: channel.name }
  } catch (err) {
    return { ok: false, error: `Não deu para abrir a conversa: ${err instanceof Error ? err.message : 'falha'}` }
  }
}
