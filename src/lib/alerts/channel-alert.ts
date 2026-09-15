// ============================================================
// 🔔 Aviso de canal com problema — sino dos owner/admin da conta e WhatsApp do
// suporte da Fluxia.
//
// 15/09 (GoLink): o Google recusou a senha de app do Gmail às 23:13 de 14/09
// e o canal seguiu verde — nem a GoLink nem a Fluxia souberam. meta-health e
// session-monitor já avisavam, cada um com a sua cópia, gravando 'sla_alert'
// (clique sem destino). Aqui fica o aviso comum, com o tipo próprio
// 'channel_alert' (migr 0172): o clique leva pra Configurações → Canais.
//
// Só owner/admin: são eles que conseguem abrir a aba de Canais e trocar senha
// ou reconectar. NUNCA manda WhatsApp pro dono da conta (incidente do loop
// dono↔canal) — o WhatsApp daqui vai só pro suporte da Fluxia.
//
// Worker-reachable: sem 'server-only'.
// ============================================================

import { eq } from 'drizzle-orm'

import { db, member, notifications } from '@/db'
import { publishEvent } from '@/lib/events/publish'
import { getProvider } from '@/lib/channels/registry'
import { loadChannel } from '@/lib/channels/channels'

/** Erro do Postgres "violou o CHECK" (a 0172 ainda não rodou neste banco). */
function isCheckViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null
  return e?.code === '23514' || e?.cause?.code === '23514'
}

/**
 * Notificação 'channel_alert' pra cada owner/admin da conta + ping no sino
 * (SSE). Retorna quantos membros foram avisados. LANÇA se o insert falhar — o
 * chamador decide (a saúde do Gmail devolve a reserva do aviso pra tentar de
 * novo na próxima falha).
 */
export async function notifyChannelAdmins(accountId: string, title: string, body: string): Promise<number> {
  const members = await db
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(eq(member.organizationId, accountId))
  const ids = members.filter((m) => m.role === 'owner' || m.role === 'admin').map((m) => m.userId)
  if (ids.length === 0) {
    console.warn('[channel-alert] conta %s sem owner/admin pra avisar: %s', accountId, title)
    return 0
  }
  const rows = (type: 'channel_alert' | 'sla_alert') =>
    ids.map((userId) => ({ accountId, userId, type, title, body }))
  try {
    await db.insert(notifications).values(rows('channel_alert'))
  } catch (err) {
    // Deploy antes da migração (lição da 0155): o tipo novo bate no CHECK.
    // Melhor um aviso com clique sem destino do que aviso nenhum.
    if (!isCheckViolation(err)) throw err
    console.warn('[channel-alert] notifications.type sem channel_alert (rodar a 0172) — gravando como sla_alert')
    await db.insert(notifications).values(rows('sla_alert'))
  }
  await publishEvent(accountId, { type: 'notification' })
  return ids.length
}

/**
 * Aviso no WhatsApp da Fluxia (mesmo destino dos chamados de suporte).
 * Best-effort: nunca lança. `tag` só identifica quem chamou no log.
 */
export async function alertPlatform(text: string, tag = 'channel-alert'): Promise<void> {
  try {
    const channelId =
      process.env.PLATFORM_SUPPORT_CHANNEL_ID?.trim() || process.env.PLATFORM_BILLING_CHANNEL_ID?.trim()
    if (!channelId) return
    const to = process.env.PLATFORM_SUPPORT_ALERT_TO?.replace(/\D/g, '').trim() || '556791806048'
    const ch = await loadChannel(channelId)
    if (!ch) return
    await getProvider(ch.provider).sendText(ch, to, text)
  } catch (err) {
    console.error(`[${tag}] aviso à plataforma falhou:`, err)
  }
}
