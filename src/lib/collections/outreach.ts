// ============================================================
// 🧾 Alcançar o devedor: por onde a cobrança sai e em que conversa.
//
// Item 1 (05/09): a régua abre a conversa sozinha para quem nunca escreveu,
// no número que a conta escolheu para cobrar (ou no único conectado — com mais
// de um, pedimos a escolha em vez de chutar de qual número o cliente recebe
// uma cobrança).
// Item 3 (05/09): e-mail. `collections.channel` decide (auto / whatsapp /
// email / both); a decisão é pura (rules.deliveryPlan) e aqui só se apuram os
// fatos: o que o contato tem, o que a conta tem, que conversas já existem.
//
// Sem 'server-only' — o executor roda no worker.
// ============================================================

import { and, desc, eq, inArray } from 'drizzle-orm'

import { db, channels, contacts, conversations } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { ensureConversationForContact } from '@/lib/whatsapp/resolve-conversation'

import { deliveryPlan, normalizeSettings } from './rules'

/** Provedores que são WhatsApp. */
export const WHATSAPP_PROVIDERS = ['meta', 'waha', 'evolution', 'evogo'] as const
/** Provedores que são e-mail. */
export const EMAIL_PROVIDERS = ['email', 'gmail'] as const

const isWa = (p: string) => (WHATSAPP_PROVIDERS as readonly string[]).includes(p)
const isEmail = (p: string) => (EMAIL_PROVIDERS as readonly string[]).includes(p)

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
    if (!chosen) return { ok: false, error: 'o número escolhido para cobrar não existe mais nesta conta — escolha outro em Cobranças → Ajustar' }
    if (chosen.status !== 'connected') {
      return { ok: false, error: `o número "${chosen.name}" está desconectado — reconecte ou escolha outro em Cobranças → Ajustar` }
    }
    return { ok: true, id: chosen.id, name: chosen.name }
  }

  const connected = rows.filter((r) => r.status === 'connected')
  if (connected.length === 1) return { ok: true, id: connected[0].id, name: connected[0].name }
  if (!connected.length) return { ok: false, error: 'nenhum número de WhatsApp conectado para enviar a cobrança' }
  return { ok: false, error: 'há mais de um número conectado: escolha em Cobranças → Ajustar qual deles envia as cobranças' }
}

/** Canal de e-mail da conta (o primeiro conectado). */
export async function pickEmailChannel(accountId: string): Promise<ChannelPick> {
  const rows = await db
    .select({ id: channels.id, name: channels.name, status: channels.status })
    .from(channels)
    .where(and(eq(channels.accountId, accountId), inArray(channels.provider, [...EMAIL_PROVIDERS])))
    .orderBy(channels.createdAt)
  const connected = rows.find((r) => r.status === 'connected')
  if (connected) return { ok: true, id: connected.id, name: connected.name }
  return { ok: false, error: rows.length ? 'o canal de e-mail da conta está desconectado' : 'nenhum canal de e-mail conectado — conecte um em Canais para cobrar por e-mail' }
}

export interface CollectionTarget {
  conversationId: string
  /** true = a conversa foi aberta agora (dryRun nunca abre: vem vazio). */
  created: boolean
}

export interface CollectionTargets {
  whatsapp: CollectionTarget | null
  email: (CollectionTarget & { address: string }) | null
  /** "WhatsApp", "e-mail" ou "WhatsApp e e-mail" — vai para a fila de aprovação. */
  label: string
}

export type TargetsOutcome = ({ ok: true } & CollectionTargets) | { ok: false; error: string }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Decide por onde esta cobrança sai e garante as conversas (a menos que
 * `dryRun`, usado pela régua só para rotular a fila: "vai por e-mail").
 * Conversa existente do contato no canal certo é reaproveitada; sem ela, abre
 * no número/canal escolhido. Nunca abre conversa em dryRun.
 */
export async function resolveCollectionTargets(
  accountId: string,
  contactId: string,
  hintConversationId: string | null,
  opts: { dryRun?: boolean } = {},
): Promise<TargetsOutcome> {
  const contact = firstOrNull(
    await db
      .select({ phone: contacts.phone, email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
      .limit(1),
  )
  if (!contact) return { ok: false, error: 'Contato não encontrado.' }

  const settings = normalizeSettings((await getAccountSettings(accountId)).collections)
  const hasPhone = (contact.phone ?? '').replace(/\D/g, '').length >= 10
  const address = (contact.email ?? '').trim().toLowerCase()
  const hasEmail = EMAIL_RE.test(address)

  // Conversas que o contato já tem, com o provedor do canal de cada uma.
  const convs = await db
    .select({ id: conversations.id, channelId: channels.id, provider: channels.provider, status: channels.status })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(and(eq(conversations.accountId, accountId), eq(conversations.contactId, contactId)))
    .orderBy(desc(conversations.lastMessageAt))

  const waConv = (hintConversationId ? convs.find((c) => c.id === hintConversationId && isWa(c.provider)) : undefined) ?? convs.find((c) => isWa(c.provider))
  const emConv = convs.find((c) => isEmail(c.provider))

  const waPick: ChannelPick = waConv ? { ok: true, id: waConv.channelId, name: '' } : await pickCollectionChannel(accountId, settings.channelId)
  const emPick: ChannelPick = emConv ? { ok: true, id: emConv.channelId, name: '' } : await pickEmailChannel(accountId)

  const plan = deliveryPlan({
    channel: settings.channel,
    hasPhone,
    hasEmail,
    whatsappError: waPick.ok ? null : waPick.error,
    emailError: emPick.ok ? null : emPick.error,
  })
  if (!plan.ok) return plan

  try {
    let whatsapp: CollectionTarget | null = null
    let email: (CollectionTarget & { address: string }) | null = null
    if (plan.whatsapp && waPick.ok) {
      whatsapp = waConv
        ? { conversationId: waConv.id, created: false }
        : opts.dryRun
          ? { conversationId: '', created: false }
          : await ensureConversationForContact(accountId, contactId, waPick.id)
    }
    if (plan.email && emPick.ok) {
      const base = emConv
        ? { conversationId: emConv.id, created: false }
        : opts.dryRun
          ? { conversationId: '', created: false }
          : await ensureConversationForContact(accountId, contactId, emPick.id)
      email = { ...base, address }
    }
    return { ok: true, whatsapp, email, label: plan.label }
  } catch (err) {
    return { ok: false, error: `Não deu para abrir a conversa: ${err instanceof Error ? err.message : 'falha'}` }
  }
}

export type OpenOutcome =
  | { ok: true; conversationId: string; created: boolean; channelName: string }
  | { ok: false; error: string }

/** Compat: abre (ou reencontra) só a conversa de WhatsApp de cobrança. */
export async function openCollectionConversation(accountId: string, contactId: string): Promise<OpenOutcome> {
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
