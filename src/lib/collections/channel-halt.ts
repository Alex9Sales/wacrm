// ============================================================
// 🛑 Régua parada porque o NÚMERO está fora do ar (ou queimando).
//
// 22/09 (GoLink): o número "Cobranças" caiu às 9h (sessão derrubada — o
// cliente falou em ban) e a régua seguiu tentando até as 16h: 142 envios
// falhados com "Session status is not as expected", 3 tentativas cada, e 16
// pedidos expirados à meia-noite. Cada tentativa numa sessão derrubada é mais
// um sinal ruim para o WhatsApp e ainda gasta o teto do dia à toa.
//
// O Disparo já parava nesse caso (queue/errors.ts + haltBroadcast). A régua
// não. Aqui está a metade que faltava, em duas camadas:
//   1. ANTES de montar a fila e antes de cada envio: o número que cobra está
//      conectado? Se não, a rodada nem começa (nada é montado, nada falha).
//   2. DEPOIS de um erro de canal (sessão caída / reputação 463): marca o
//      canal como fora do ar, avisa o dono uma vez e para — em vez de gastar
//      as 3 tentativas do pedido e seguir para o próximo devedor.
//
// Sem 'server-only' — roda no worker.
// ============================================================

import { and, eq, inArray } from 'drizzle-orm'

import { channels, db } from '@/db'
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

export interface ChannelSnapshot {
  id: string
  name: string
  status: string
}

/**
 * A régua pode enviar agora? PURA — a parte que decide, para testar sem banco.
 *
 * `chosen` = número escolhido em Ajustar (settings.channelId). Sem escolha, a
 * régua usa o único conectado; então basta existir UM conectado.
 *
 * Quem cobra por e-mail não depende de WhatsApp nenhum, e no 'auto' (padrão)
 * a conta que nem tem número cadastrado segue cobrando por e-mail — só para
 * quando ela TEM número e ele está fora do ar.
 */
export function collectionChannelHalt(input: {
  channel: CollectionsSettings['channel']
  chosen: ChannelSnapshot | null
  /** Todos os canais de WhatsApp da conta. */
  whatsapp: readonly ChannelSnapshot[]
}): { ok: true } | { ok: false; reason: string } {
  if (input.channel === 'email') return { ok: true }
  if (input.chosen) {
    if (input.chosen.status === 'connected') return { ok: true }
    return {
      ok: false,
      reason: `O número "${input.chosen.name}" está fora do ar (${statusLabel(input.chosen.status)}). A régua não cobra por um número desconectado — reconecte em Canais.`,
    }
  }
  if (!input.whatsapp.length) {
    // 'auto' sem número cadastrado = conta de e-mail: deixa passar.
    if (input.channel === 'auto') return { ok: true }
    return { ok: false, reason: 'Nenhum número de WhatsApp conectado para cobrar.' }
  }
  if (input.whatsapp.some((c) => c.status === 'connected')) return { ok: true }
  const nomes = input.whatsapp.map((c) => c.name).join(', ')
  return {
    ok: false,
    reason: `Nenhum número conectado agora (${nomes}). A régua espera o número voltar — reconecte em Canais.`,
  }
}

function statusLabel(status: string): string {
  if (status === 'error') return 'sessão caiu'
  if (status === 'disconnected') return 'desconectado'
  if (status === 'connecting') return 'conectando'
  return status
}

/** Lê o estado real dos canais e decide. Falha de leitura → deixa passar (nunca trava a régua por erro nosso). */
export async function collectionChannelBlocked(
  accountId: string,
  settings: CollectionsSettings,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const rows = await db
      .select({ id: channels.id, name: channels.name, status: channels.status })
      .from(channels)
      .where(and(eq(channels.accountId, accountId), inArray(channels.provider, [...WHATSAPP_PROVIDERS])))
    const chosen = settings.channelId ? (rows.find((r) => r.id === settings.channelId) ?? null) : null
    return collectionChannelHalt({ channel: settings.channel, chosen, whatsapp: rows })
  } catch (err) {
    console.error('[cobranca] conferir o número da régua falhou:', err instanceof Error ? err.message : err)
    return { ok: true }
  }
}

/**
 * Erro de CANAL num envio da régua: marca o número como fora do ar (o banner
 * do CRM e a guarda acima passam a enxergar) e avisa o dono uma vez. Nunca
 * lança — o envio já falhou, o aviso é extra.
 */
export async function handleCollectionChannelFailure(args: {
  accountId: string
  reason: ChannelHaltReason
  error: string
  settings: CollectionsSettings
}): Promise<void> {
  const nome = await marcarCanalForaDoAr(args.accountId, args.settings)
  const motivo =
    args.reason === 'reputation'
      ? `o WhatsApp começou a recusar os envios desse número (reputação). Insistir piora e pode banir o número.`
      : `a sessão do WhatsApp caiu (deslogado ou fora do ar).`
  console.error(`[cobranca] régua parada — número ${nome ?? '(desconhecido)'}: ${motivo} (${args.error.slice(0, 120)})`)
  await avisarDono(args.accountId, nome, motivo)
}

/** Marca o número escolhido como fora do ar. Devolve o nome dele (para o aviso). */
async function marcarCanalForaDoAr(accountId: string, settings: CollectionsSettings): Promise<string | null> {
  try {
    if (!settings.channelId) return null
    const row = await db
      .select({ id: channels.id, name: channels.name, status: channels.status })
      .from(channels)
      .where(and(eq(channels.accountId, accountId), eq(channels.id, settings.channelId)))
      .limit(1)
    const ch = row[0]
    if (!ch) return null
    if (ch.status !== 'error') await updateChannelStatus(ch.id, 'error')
    return ch.name
  } catch (err) {
    console.error('[cobranca] marcar o número como fora do ar falhou:', err instanceof Error ? err.message : err)
    return null
  }
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
      console.warn('[cobranca] sem número conectado para avisar que a régua parou')
      return
    }
    const texto =
      `⚠️ Cobranças pausadas\n\n` +
      `O número ${nome ? `"${nome}"` : 'que envia as cobranças'} está fora do ar: ${motivo}\n\n` +
      `Enquanto isso a régua não envia nada — nenhuma cobrança se perde, ela retoma sozinha quando o número voltar. ` +
      `Reconecte em Canais e confira em Cobranças.`
    await markSelfMessage(texto)
    await getProvider(wa.provider).sendText(wa, phone, texto)
  } catch (err) {
    console.error('[cobranca] aviso de número fora do ar falhou:', err instanceof Error ? err.message : err)
  }
}
