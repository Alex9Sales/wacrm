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
import { markSelfMessage } from '@/lib/ai/self-message'
import { alertContactName } from './alert-text'
import {
  DEFAULT_ALERT_TEMPLATES,
  renderAlertTemplate,
  type OwnerAlertKind,
} from './templates'

const WHATSAPP_PROVIDERS = ['waha', 'meta', 'evolution', 'evogo']

export type { OwnerAlertKind }

/**
 * O aviso em UMA linha, pro corpo do template. A Meta recusa variável com
 * quebra de linha, tabulação ou 4 espaços seguidos — então as linhas viram
 * " · " e o texto é cortado com reticências.
 */
export function flattenForTemplate(text: string, max = 900): string {
  const one = text
    .replace(/\s*\n+\s*/g, ' · ')
    .replace(/\s{3,}/g, ' ')
    .trim()
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one
}

const KIND_TOGGLE: Record<
  OwnerAlertKind,
  | 'alertOnWon'
  | 'alertOnHandoff'
  | 'alertOnBooking'
  | 'alertOnOrder'
  | 'alertOnDemo'
  | 'alertOnHandoffStalled'
> = {
  won: 'alertOnWon',
  handoff: 'alertOnHandoff',
  booking: 'alertOnBooking',
  order: 'alertOnOrder',
  demo: 'alertOnDemo',
  handoff_stalled: 'alertOnHandoffStalled',
}

// 02/10/2026: o aviso de transferência parada não tem texto personalizável
// (sai sempre o padrão) — por isso o mapa é parcial.
const KIND_TEMPLATE: Partial<
  Record<
    OwnerAlertKind,
    | 'alertWonTemplate'
    | 'alertHandoffTemplate'
    | 'alertBookingTemplate'
    | 'alertOrderTemplate'
    | 'alertDemoTemplate'
  >
> = {
  won: 'alertWonTemplate',
  handoff: 'alertHandoffTemplate',
  booking: 'alertBookingTemplate',
  order: 'alertOrderTemplate',
  demo: 'alertDemoTemplate',
}

/** Por que o aviso não saiu. 'erro' = exceção (banco, canal); os outros são
 *  configuração e se repetem igual na próxima tentativa. */
export type FalhaDoAviso = 'desligado' | 'sem_texto' | 'sem_canal' | 'erro'

/**
 * Resultado do envio. `tentou` = chegou a CHAMAR o provedor do canal (02/10/
 * 2026, revisão do aviso de transferência parada): falha com tentou=true é
 * AMBÍGUA — o WAHA pode abortar por tempo (15 s) e ainda assim entregar —,
 * então quem pode repetir o envio não deve repetir; com tentou=false a falha é
 * certa e nada saiu.
 */
export interface ResultadoDoAviso {
  ok: boolean
  tentou: boolean
  falha?: FalhaDoAviso
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
): Promise<ResultadoDoAviso> {
  let tentou = false
  try {
    const s = await getAccountSettings(accountId)
    const phone = s.alertPhone.replace(/\D/g, '')
    if (!phone || !s[KIND_TOGGLE[kind]]) return { ok: false, tentou, falha: 'desligado' }

    const templateKey = KIND_TEMPLATE[kind]
    const template = ((templateKey ? s[templateKey] : '') || '').trim() || DEFAULT_ALERT_TEMPLATES[kind]
    // Nome sem letra ("." do perfil do WhatsApp) não é nome: a linha sai só com
    // o telefone (16/09, Família do Gás: "👤 . · 5567…"). Vale pra todo aviso.
    const clean = { ...vars }
    for (const k of ['cliente', 'nome'] as const) {
      if (!(k in clean)) continue
      const nice = alertContactName(clean[k], clean.telefone)
      // Sem telefone pra identificar, fica o nome cru (ex.: "Ⓜⓐⓡⓘⓐ") — só
      // some quando não sobra nada além de pontuação/espaço.
      const raw = (clean[k] ?? '').trim()
      clean[k] = nice || (!clean.telefone?.trim() && /[^\s\p{P}]/u.test(raw) ? raw : '')
    }
    const text = renderAlertTemplate(template, clean)
    if (!text) return { ok: false, tentou, falha: 'sem_texto' }

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
      return { ok: false, tentou, falha: 'sem_canal' }
    }
    // Destino pode ser um canal com IA (ver lib/ai/self-message.ts): marca o
    // texto pra IA não responder ao próprio aviso do sistema.
    const provider = getProvider(wa.provider)
    try {
      await markSelfMessage(text)
      // Daqui em diante uma exceção NÃO prova que a mensagem não saiu.
      tentou = true
      await provider.sendText(wa, phone, text)
      return { ok: true, tentou }
    } catch (err) {
      // 🚫 Canal oficial (Meta) fora da janela de 24h recusa texto livre, e o
      // aviso sumia (17/09, Limpeza com Zelo: o resumo da reunião nunca
      // chegaria no WhatsApp do dono). Com um template aprovado configurado,
      // o MESMO aviso vai por ele, em uma linha só.
      const tpl = (s.alertTemplateName || '').trim()
      if (!tpl || !provider.sendTemplate) throw err
      const flat = flattenForTemplate(text)
      await markSelfMessage(flat)
      await provider.sendTemplate(wa, phone, {
        name: tpl,
        language: (s.alertTemplateLanguage || '').trim() || 'pt_BR',
        params: [flat],
      })
      console.warn(
        `[owner-alerts] texto recusado pelo canal (${err instanceof Error ? err.message : err}); aviso ${kind} enviado pelo template ${tpl}`,
      )
      return { ok: true, tentou }
    }
  } catch (err) {
    console.error(`[owner-alerts] falha ao enviar aviso ${kind}:`, err)
    return { ok: false, tentou, falha: 'erro' }
  }
}
