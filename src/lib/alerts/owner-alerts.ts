// ============================================================
// 📣 Avisos do responsável — o "manda no grupo da empresa" que toda operação
// pequena faz na mão (caso real: Família do Gás manda resumo do pedido pro
// zap do despacho e avisa o gestor quando a IA escala). Config por conta em
// account_settings (alertPhone + toggles por evento, TUDO off por padrão).
// Best-effort SEMPRE: um aviso que falha nunca pode derrubar a venda, a
// transferência ou o agendamento que o disparou.
// Sem 'server-only' — alcançável de rota, action e worker.
// ============================================================

import { listChannels } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import { getAccountSettings } from '@/lib/settings/account-settings'
import {
  DEFAULT_ALERT_TEMPLATES,
  renderAlertTemplate,
  type OwnerAlertKind,
} from './templates'

const WHATSAPP_PROVIDERS = ['waha', 'meta', 'evolution', 'evogo']

export type { OwnerAlertKind }

const KIND_TOGGLE: Record<
  OwnerAlertKind,
  'alertOnWon' | 'alertOnHandoff' | 'alertOnBooking' | 'alertOnOrder'
> = {
  won: 'alertOnWon',
  handoff: 'alertOnHandoff',
  booking: 'alertOnBooking',
  order: 'alertOnOrder',
}

const KIND_TEMPLATE: Record<
  OwnerAlertKind,
  | 'alertWonTemplate'
  | 'alertHandoffTemplate'
  | 'alertBookingTemplate'
  | 'alertOrderTemplate'
> = {
  won: 'alertWonTemplate',
  handoff: 'alertHandoffTemplate',
  booking: 'alertBookingTemplate',
  order: 'alertOrderTemplate',
}

/**
 * Envia o aviso do evento pro WhatsApp do responsável — se a conta tiver
 * telefone configurado E o toggle daquele evento ligado. A mensagem sai do
 * template da CONTA (editável) ou do padrão. Nunca lança.
 */
export async function sendOwnerAlert(
  accountId: string,
  kind: OwnerAlertKind,
  vars: Record<string, string>,
): Promise<boolean> {
  try {
    const s = await getAccountSettings(accountId)
    const phone = s.alertPhone.replace(/\D/g, '')
    if (!phone || !s[KIND_TOGGLE[kind]]) return false

    const template = (s[KIND_TEMPLATE[kind]] || '').trim() || DEFAULT_ALERT_TEMPLATES[kind]
    const text = renderAlertTemplate(template, vars)
    if (!text) return false

    const channels = await listChannels(accountId)
    const wa =
      (s.alertChannelId
        ? channels.find(
            (c) =>
              c.id === s.alertChannelId &&
              WHATSAPP_PROVIDERS.includes(c.provider),
          )
        : null) ?? channels.find((c) => WHATSAPP_PROVIDERS.includes(c.provider))
    if (!wa) {
      console.warn(`[owner-alerts] conta ${accountId} sem canal WhatsApp p/ avisar`)
      return false
    }
    await getProvider(wa.provider).sendText(wa, phone, text)
    return true
  } catch (err) {
    console.error(`[owner-alerts] falha ao enviar aviso ${kind}:`, err)
    return false
  }
}
