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

import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import { db, asaasCharges, channels, contacts, conversations } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { ensureConversationForContact } from '@/lib/whatsapp/resolve-conversation'
import { gmailSendBlockedReason } from '@/lib/channels/gmail-health-state'

import { suppressedEmails } from './email-suppression'

import { collectionEmail, deliveryPlan, normalizeSettings } from './rules'

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

/** Motivo pra não mandar e-mail por este canal agora (Gmail com senha recusada). */
function emailChannelBlocked(c: { provider: string; providerMeta: unknown }): string | null {
  return c.provider === 'gmail' ? gmailSendBlockedReason(c.providerMeta) : null
}

/**
 * Canal de e-mail da conta (o primeiro conectado). 15/09 (GoLink): Gmail com a
 * senha de app recusada fica de fora — cada tentativa era mais um login
 * recusado no Google (a régua manda a cada 5 min) e a falha só aparecia como
 * erro do e-mail depois do WhatsApp.
 */
export async function pickEmailChannel(accountId: string, emailChannelId: string | null = null): Promise<ChannelPick> {
  const rows = await db
    .select({ id: channels.id, name: channels.name, status: channels.status, provider: channels.provider, providerMeta: channels.providerMeta })
    .from(channels)
    .where(and(eq(channels.accountId, accountId), inArray(channels.provider, [...EMAIL_PROVIDERS])))
    .orderBy(channels.createdAt)
  // 22/09: e-mail ESCOLHIDO em Ajustar manda sempre (como o número escolhido).
  if (emailChannelId) {
    const chosen = rows.find((r) => r.id === emailChannelId)
    if (!chosen) return { ok: false, error: 'o e-mail escolhido para cobrar não existe mais nesta conta — escolha outro em Cobranças → Ajustar' }
    if (chosen.status !== 'connected') return { ok: false, error: `o e-mail "${chosen.name}" está desconectado — reconecte ou escolha outro em Cobranças → Ajustar` }
    const blocked = emailChannelBlocked(chosen)
    if (blocked) return { ok: false, error: blocked }
    return { ok: true, id: chosen.id, name: chosen.name }
  }
  const connected = rows.filter((r) => r.status === 'connected')
  const usable = connected.find((r) => !emailChannelBlocked(r))
  if (usable) return { ok: true, id: usable.id, name: usable.name }
  const blocked = connected.map(emailChannelBlocked).find(Boolean)
  if (blocked) return { ok: false, error: blocked }
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

/**
 * E-mails do cliente nas parcelas do Asaas (para quem não tem e-mail no
 * contato) — aberta primeiro, a mais recente. Até 5: se o primeiro voltou
 * (email_bounces), vale o próximo.
 */
async function asaasChargeEmails(accountId: string, contactId: string): Promise<string[]> {
  const rows = await db
    .select({ email: asaasCharges.email })
    .from(asaasCharges)
    .where(
      and(
        eq(asaasCharges.accountId, accountId),
        eq(asaasCharges.contactId, contactId),
        sql`nullif(trim(${asaasCharges.email}), '') IS NOT NULL`,
      ),
    )
    .orderBy(desc(asaasCharges.open), desc(asaasCharges.updatedAt))
    .limit(5)
  return rows.map((r) => r.email).filter((e): e is string => typeof e === 'string')
}

/**
 * Decide por onde esta cobrança sai e garante as conversas (a menos que
 * `dryRun`, usado pela régua só para rotular a fila: "vai por e-mail").
 * Com número escolhido em Ajustar, a conversa é a DESSE número (reaproveita a
 * existente nele ou abre uma); sem número escolhido, reaproveita a conversa
 * de WhatsApp existente do contato, senão abre no único conectado. Nunca abre
 * conversa em dryRun.
 */
export async function resolveCollectionTargets(
  accountId: string,
  contactId: string,
  hintConversationId: string | null,
  opts: {
    dryRun?: boolean
    /** E-mail do cliente no Asaas já em mãos (lembrete: vem da API na hora, não da carteira). */
    fallbackEmail?: unknown
  } = {},
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
  // 📧 14/09 (João/GoLink): só o e-mail do CONTATO valia, e 18 de 30 devedores
  // com e-mail no Asaas ficavam sem e-mail nenhum — com os avisos do Asaas
  // desligados, ninguém mais mandava. Sem e-mail no contato, vale o do cliente
  // no Asaas. Não gravamos no contato: parcela ligada ao contato errado (o
  // teste "Paulo Exemplo" caiu no número do próprio João) espalharia o e-mail
  // de um cliente em outro.
  //
  // 📭 15/09 (Vale Modelo): endereço que voltou como não entregue
  // (email_bounces) fica de fora em todos eles — a régua ia mandar de novo pro
  // domínio que não recebe e-mail. Se a consulta falhar, manda como antes.
  const hint = typeof opts.fallbackEmail === 'string' ? opts.fallbackEmail : null
  const chargeEmails = await asaasChargeEmails(accountId, contactId)
  const candidates = [contact.email, hint, ...chargeEmails]
  const bounced = await suppressedEmails(accountId, candidates).catch((err) => {
    console.error('[collections] consulta de e-mails devolvidos falhou conta=%s contato=%s:', accountId, contactId, err)
    return new Set<string>()
  })
  const firstUsable = (skip?: ReadonlySet<string>) =>
    collectionEmail(contact.email, skip) ??
    collectionEmail(hint, skip) ??
    chargeEmails.map((e) => collectionEmail(e, skip)).find(Boolean) ??
    null
  const address = firstUsable(bounced) ?? ''
  const hasEmail = !!address
  const emailBlocked = !hasEmail && bounced.size > 0 ? firstUsable() : null

  // Conversas que o contato já tem, com o provedor do canal de cada uma.
  const convs = await db
    .select({ id: conversations.id, channelId: channels.id, provider: channels.provider, status: channels.status, providerMeta: channels.providerMeta })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(and(eq(conversations.accountId, accountId), eq(conversations.contactId, contactId)))
    .orderBy(desc(conversations.lastMessageAt))

  // 10/09 (GoLink): com "Número que envia as cobranças" ESCOLHIDO, a cobrança
  // sai SEMPRE por ele — mesmo que o devedor já converse com o Wilian ou o
  // Vitor. Antes o número escolhido só valia pra quem não tinha conversa, e a
  // régua reaproveitava a conversa mais recente em qualquer número (3 das 6
  // primeiras cobranças saíram pelo número do vendedor). Sem número escolhido
  // (automático), continua: reaproveita a conversa de WhatsApp existente.
  const fixedChannel = settings.channelId
  const isWaOnFixed = (c: { channelId: string; provider: string }) => isWa(c.provider) && (!fixedChannel || c.channelId === fixedChannel)
  const waConv =
    (hintConversationId ? convs.find((c) => c.id === hintConversationId && isWaOnFixed(c)) : undefined) ?? convs.find((c) => isWaOnFixed(c))
  // Conversa de e-mail num Gmail com a senha recusada não serve: vale o canal
  // de e-mail que funciona (ou o motivo, na fila). Com e-mail ESCOLHIDO em
  // Ajustar (22/09), só a conversa nesse e-mail serve — como no número.
  const fixedEmail = settings.emailChannelId
  const emConv = convs.find((c) => isEmail(c.provider) && (!fixedEmail || c.channelId === fixedEmail) && !emailChannelBlocked(c))

  const waPick: ChannelPick = waConv ? { ok: true, id: waConv.channelId, name: '' } : await pickCollectionChannel(accountId, settings.channelId)
  const emPick: ChannelPick = emConv ? { ok: true, id: emConv.channelId, name: '' } : await pickEmailChannel(accountId, fixedEmail)

  const plan = deliveryPlan({
    channel: settings.channel,
    hasPhone,
    hasEmail,
    whatsappError: waPick.ok ? null : waPick.error,
    emailError: emPick.ok ? null : emPick.error,
    emailBlocked,
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
