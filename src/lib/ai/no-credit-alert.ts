// ============================================================
// 💳 Chave de IA sem crédito — identificar a conta e avisar a plataforma.
//
// 22/09 (Família do Gás): a chave da OpenAI da conta ficou sem saldo às 08h43
// e a Maria parou de responder. O log só dizia "You have no credits
// remaining" — sem o nome do cliente —, então a falha foi atribuída à conta
// errada no dia anterior e ninguém soube até o dono reclamar.
//
// Aqui ficam as duas metades do conserto:
//   1. `accountLabel` para o log dizer DE QUEM é a falha;
//   2. `warnNoCredit` para avisar o WhatsApp do operador da plataforma na
//      primeira falha por saldo de cada conta (dedup por Redis + memória).
//
// Best-effort do começo ao fim: avisar nunca pode derrubar o atendimento.
// Sem 'server-only' — roda no worker.
// ============================================================

import { eq } from 'drizzle-orm'

import { db, member, organization, user } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { listChannels } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import { markSelfMessage } from '@/lib/ai/self-message'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { bumpCounter } from '@/lib/ai/reply-marker'

const WHATSAPP_PROVIDERS = ['waha', 'meta', 'evolution', 'evogo']

/** Um aviso por conta a cada 6 h: o erro se repete a cada mensagem do cliente. */
const ALERT_TTL_SECONDS = 6 * 3600

/** Segunda trava, para o caso de o Redis estar fora (evita repetir sem parar). */
const avisadoEmMemoria = new Map<string, number>()

/**
 * A falha é "acabou o crédito" (e não chave errada, modelo inexistente ou
 * instabilidade)? A OpenAI devolve 429 com `insufficient_quota`; o texto muda
 * conforme o plano, então casamos pelas três formas que ela usa.
 */
export function isNoCreditError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase()
  if (!msg) return false
  return (
    msg.includes('no credits remaining') ||
    msg.includes('insufficient_quota') ||
    msg.includes('exceeded your current quota')
  )
}

const labelCache = new Map<string, string>()

/** Nome da conta para o log ("Familia do Gás (159fb7d6)"). Nunca lança. */
export async function accountLabel(accountId: string | null | undefined): Promise<string> {
  if (!accountId) return 'conta desconhecida'
  const cached = labelCache.get(accountId)
  if (cached) return cached
  let label = accountId.slice(0, 8)
  try {
    const row = firstOrNull(
      await db.select({ name: organization.name }).from(organization).where(eq(organization.id, accountId)).limit(1),
    )
    if (row?.name) label = `${row.name.trim()} (${accountId.slice(0, 8)})`
  } catch {
    /* o log não pode depender do banco */
  }
  labelCache.set(accountId, label)
  return label
}

/**
 * Para onde vai o aviso: o WhatsApp do operador da plataforma. Sem variável de
 * ambiente nova — sai da conta do próprio platform admin
 * (`PLATFORM_ADMIN_EMAILS`), que já tem telefone e canal de aviso na tela de
 * Ajustes. Null quando não dá para descobrir (aí fica só o log).
 */
async function platformTarget(): Promise<{ accountId: string; phone: string; channelId: string | null } | null> {
  const emails = (process.env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  if (!emails.length) return null

  for (const email of emails) {
    const u = firstOrNull(await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1))
    if (!u) continue
    const m = firstOrNull(
      await db.select({ organizationId: member.organizationId }).from(member).where(eq(member.userId, u.id)).limit(1),
    )
    if (!m?.organizationId) continue
    const s = await getAccountSettings(m.organizationId)
    const phone = (s.alertPhone ?? '').replace(/\D/g, '')
    if (!phone) continue
    return { accountId: m.organizationId, phone, channelId: (s.alertChannelId ?? '').trim() || null }
  }
  return null
}

function jaAvisouEmMemoria(accountId: string): boolean {
  const agora = Date.now()
  const quando = avisadoEmMemoria.get(accountId)
  if (quando && agora - quando < ALERT_TTL_SECONDS * 1000) return true
  avisadoEmMemoria.set(accountId, agora)
  return false
}

/**
 * Loga a falha COM o nome da conta e, na primeira vez em 6 h, manda um
 * WhatsApp para o operador da plataforma. `where` diz o que parou
 * ("atendimento", "follow-up", "detector de cobrança").
 */
export async function warnNoCredit(args: {
  accountId: string | null | undefined
  where: string
  err: unknown
}): Promise<void> {
  const label = await accountLabel(args.accountId)
  console.error(`[ia sem crédito] ${label} — ${args.where} parou: a chave de IA da conta está sem saldo`)
  if (!args.accountId) return

  try {
    if (jaAvisouEmMemoria(args.accountId)) return
    const n = await bumpCounter(`ia:sem-credito:${args.accountId}`, ALERT_TTL_SECONDS)
    if (n !== undefined && n > 1) return

    const alvo = await platformTarget()
    if (!alvo) {
      console.warn('[ia sem crédito] sem telefone de aviso configurado na conta do platform admin')
      return
    }
    const channels = await listChannels(alvo.accountId)
    const wa =
      (alvo.channelId
        ? channels.find((c) => c.id === alvo.channelId && WHATSAPP_PROVIDERS.includes(c.provider))
        : null) ?? channels.find((c) => WHATSAPP_PROVIDERS.includes(c.provider))
    if (!wa) {
      console.warn('[ia sem crédito] conta do platform admin sem canal WhatsApp p/ avisar')
      return
    }
    const texto =
      `⚠️ IA parada por falta de crédito\n\n` +
      `Cliente: ${label}\n` +
      `O que parou: ${args.where}\n\n` +
      `A chave de IA dessa conta está sem saldo — a IA não responde até recarregar.`
    await markSelfMessage(texto)
    await getProvider(wa.provider).sendText(wa, alvo.phone, texto)
  } catch (err) {
    console.error('[ia sem crédito] não deu para avisar:', err instanceof Error ? err.message : err)
  }
}
