// ============================================================
// 📞 "Este número recebe WhatsApp?" — pergunta ao próprio WhatsApp.
//
// 11/09 (João/GoLink): eu tinha barrado telefone FIXO no aviso de telefone da
// carteira, supondo que fixo não tem WhatsApp. Estava errado: o WhatsApp
// Business aceita número fixo (verificação por chamada de voz), e o fixo do
// cliente dele — 12 3648-8533 — respondeu `numberExists: true` no check-exists.
// Formato de número não decide isso; só o WhatsApp decide.
//
// Somente leitura: nada é enviado. `null` = não deu para perguntar (canal fora
// do ar, engine sem resposta), e quem chama trata como "não sei", nunca como
// "não existe".
//
// Sem 'server-only' — alcançável pelo worker.
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, channels } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadChannel } from '@/lib/channels/channels'
import { toBrE164IfNational } from '@/lib/whatsapp/phone-utils'

/** Provedores que falam o dialeto check-exists do WAHA. */
const WA_PROVIDERS = ['waha', 'evolution', 'evogo']

export interface NumberCheck {
  /** true = está no WhatsApp · false = não está · null = não deu para checar. */
  exists: boolean | null
  /** chatId canônico devolvido pelo WhatsApp (resolve o 9º dígito / LID). */
  chatId: string | null
}

const UNKNOWN: NumberCheck = { exists: null, chatId: null }

/**
 * Pergunta a um canal WhatsApp da conta se o número existe. Usa o canal
 * indicado; sem ele, o primeiro canal conectado da conta.
 */
export async function numberHasWhatsApp(
  accountId: string,
  phone: string,
  preferredChannelId?: string | null,
): Promise<NumberCheck> {
  const digits = toBrE164IfNational((phone ?? '').replace(/\D/g, ''))
  if (!digits) return UNKNOWN

  const pick =
    (preferredChannelId
      ? firstOrNull(
          await db
            .select({ id: channels.id })
            .from(channels)
            .where(and(eq(channels.id, preferredChannelId), eq(channels.accountId, accountId)))
            .limit(1),
        )
      : null) ??
    firstOrNull(
      await db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.accountId, accountId), eq(channels.status, 'connected')))
        .limit(1),
    )
  if (!pick) return UNKNOWN

  // loadChannel descriptografa as credenciais; ler a coluna crua traria o
  // ciphertext.
  let ch
  try {
    ch = await loadChannel(pick.id)
  } catch {
    return UNKNOWN
  }
  if (!ch || !WA_PROVIDERS.includes(ch.provider)) return UNKNOWN

  const base = typeof ch.providerMeta.baseUrl === 'string' ? ch.providerMeta.baseUrl.replace(/\/+$/, '') : ''
  const session = typeof ch.providerMeta.session === 'string' && ch.providerMeta.session ? ch.providerMeta.session : 'default'
  const apiKey = typeof ch.credentials.apiKey === 'string' ? ch.credentials.apiKey : ''
  if (!base) return UNKNOWN

  try {
    const res = await fetch(
      `${base}/api/contacts/check-exists?phone=${encodeURIComponent(digits)}&session=${encodeURIComponent(session)}`,
      { headers: { 'X-Api-Key': apiKey }, signal: AbortSignal.timeout(12_000) },
    )
    if (!res.ok) return UNKNOWN
    const body = (await res.json().catch(() => null)) as { numberExists?: boolean; chatId?: string } | null
    if (!body) return UNKNOWN
    return {
      exists: body.numberExists === true,
      chatId: typeof body.chatId === 'string' && body.chatId ? body.chatId : null,
    }
  } catch {
    return UNKNOWN
  }
}
