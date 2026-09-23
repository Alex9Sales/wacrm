// ============================================================
// 🛑 Número queimando: a régua para de insistir nele.
//
// 22/09 (GoLink): o número "Cobranças" caiu às 9h e a régua seguiu tentando
// até as 16h: 142 envios falhados com "Session status is not as expected", 3
// tentativas cada, e 16 pedidos expirados à meia-noite. Cada tentativa numa
// sessão derrubada é mais um sinal ruim para o WhatsApp e ainda gasta o teto
// do dia à toa.
//
// Por que a régua não percebeu sozinha: quem escolhe o número (`outreach.ts`,
// `pickCollectionChannel`) JÁ recusa canal desconectado — e cai para o e-mail
// quando a conta cobra pelos dois. Só que a sessão do WAHA tinha morrido no
// WhatsApp sem ninguém mudar o status no banco: para o CRM o número seguia
// "conectado", e a recusa nunca acontecia.
//
// Então o que faltava não era mais uma trava antes de enviar: era ESCREVER a
// queda quando ela aparece. Depois de um erro de canal (sessão caída ou
// reputação 463) marcamos o número como fora do ar e avisamos o dono uma vez.
// A partir daí a escolha de canal que já existe faz o resto — inclusive
// continuar cobrando por e-mail de quem tem e-mail, em vez de parar tudo.
//
// Sem 'server-only' — roda no worker.
// ============================================================

import { and, eq } from 'drizzle-orm'

import { channels, conversations, db } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { listChannels, updateChannelStatus } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import { markSelfMessage } from '@/lib/ai/self-message'
import { bumpCounter } from '@/lib/ai/reply-marker'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { channelHaltReason, type ChannelHaltReason } from '@/lib/queue/errors'

import { WHATSAPP_PROVIDERS } from './outreach'
import type { CollectionsSettings } from './rules'

export { channelHaltReason, type ChannelHaltReason }

/** Um aviso por conta a cada 6 h — a falha se repete a cada rodada (10 min). */
const ALERT_TTL_SECONDS = 6 * 3600
/** Segunda trava, para quando o Redis está fora. */
const avisadoEmMemoria = new Map<string, number>()

/**
 * Erro de CANAL num envio da régua: marca o número como fora do ar (a escolha
 * de canal passa a recusá-lo) e avisa o dono uma vez. Nunca lança — o envio já
 * falhou, o aviso é extra.
 */
export async function handleCollectionChannelFailure(args: {
  accountId: string
  reason: ChannelHaltReason
  error: string
  settings: CollectionsSettings
  /** A conversa do pedido que falhou — é por ela que se descobre o número. */
  conversationId?: string | null
}): Promise<void> {
  const nome = await marcarCanalForaDoAr(args.accountId, args.settings, args.conversationId ?? null)
  const motivo =
    args.reason === 'reputation'
      ? `o WhatsApp começou a recusar os envios desse número (reputação). Insistir piora e pode banir o número.`
      : `a sessão do WhatsApp caiu (deslogado ou fora do ar).`
  console.error(`[cobranca] número fora do ar ${nome ?? '(desconhecido)'}: ${motivo} (${args.error.slice(0, 120)})`)
  await avisarDono(args.accountId, nome, motivo)
}

/**
 * Marca como fora do ar o número por onde a cobrança tentou sair. Devolve o
 * nome dele (para o aviso).
 *
 * A conversa do pedido vem primeiro: em conta no automático não existe número
 * escolhido em Ajustar, e sem isso nada era marcado — a régua queimava um
 * envio por rodada para sempre (achado na revisão de 23/09).
 */
async function marcarCanalForaDoAr(
  accountId: string,
  settings: CollectionsSettings,
  conversationId: string | null,
): Promise<string | null> {
  try {
    const id = (await channelIdOfConversation(accountId, conversationId)) ?? settings.channelId
    if (!id) return null
    const ch = firstOrNull(
      await db
        .select({ id: channels.id, name: channels.name, status: channels.status, provider: channels.provider })
        .from(channels)
        .where(and(eq(channels.accountId, accountId), eq(channels.id, id)))
        .limit(1),
    )
    if (!ch) return null
    // Só número de WhatsApp: falha de e-mail tem tratamento próprio e marcar
    // um canal de e-mail como 'error' tiraria a caixa do ar sem motivo.
    if (!WHATSAPP_PROVIDERS.includes(ch.provider as (typeof WHATSAPP_PROVIDERS)[number])) return null
    if (ch.status !== 'error') await updateChannelStatus(ch.id, 'error')
    return ch.name
  } catch (err) {
    console.error('[cobranca] marcar o número como fora do ar falhou:', err instanceof Error ? err.message : err)
    return null
  }
}

/** O canal por onde a conversa do pedido fala. */
async function channelIdOfConversation(accountId: string, conversationId: string | null): Promise<string | null> {
  if (!conversationId) return null
  const row = firstOrNull(
    await db
      .select({ channelId: conversations.channelId })
      .from(conversations)
      .where(and(eq(conversations.accountId, accountId), eq(conversations.id, conversationId)))
      .limit(1),
  )
  return row?.channelId ?? null
}

/** Avisa o WhatsApp do responsável (Configurações → Avisos). Uma vez a cada 6 h. */
async function avisarDono(accountId: string, nome: string | null, motivo: string): Promise<void> {
  try {
    const agora = Date.now()
    const ultimo = avisadoEmMemoria.get(accountId) ?? 0
    if (agora - ultimo < ALERT_TTL_SECONDS * 1000) return
    avisadoEmMemoria.set(accountId, agora)
    const n = await bumpCounter(`cobranca:canal-fora:${accountId}`, ALERT_TTL_SECONDS)
    if (n !== undefined && n > 1) return

    const s = await getAccountSettings(accountId)
    const phone = (s.alertPhone || '').replace(/\D/g, '')
    if (!phone) return
    const todos = await listChannels(accountId)
    // `listChannels` devolve as credenciais, não o status — o status vem daqui.
    const conectados = new Set(
      (
        await db
          .select({ id: channels.id })
          .from(channels)
          .where(and(eq(channels.accountId, accountId), eq(channels.status, 'connected')))
      ).map((r) => r.id),
    )
    // Nunca avisar PELO número que caiu: escolhe o de avisos, senão outro conectado.
    const candidatos = todos.filter(
      (c) => WHATSAPP_PROVIDERS.includes(c.provider as (typeof WHATSAPP_PROVIDERS)[number]) && conectados.has(c.id),
    )
    const wa = (s.alertChannelId ? candidatos.find((c) => c.id === s.alertChannelId) : null) ?? candidatos[0]
    if (!wa) {
      console.warn('[cobranca] sem número conectado para avisar que o número de cobrança caiu')
      return
    }
    const texto =
      `⚠️ Número de cobrança fora do ar\n\n` +
      `O número ${nome ? `"${nome}"` : 'que envia as cobranças'} parou: ${motivo}\n\n` +
      `Enquanto isso a régua não insiste nele — nenhuma cobrança se perde, e quem tem e-mail continua sendo cobrado. ` +
      `Reconecte em Canais e confira em Cobranças.`
    await markSelfMessage(texto)
    await getProvider(wa.provider).sendText(wa, phone, texto)
  } catch (err) {
    console.error('[cobranca] aviso de número fora do ar falhou:', err instanceof Error ? err.message : err)
  }
}
