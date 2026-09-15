// ============================================================
// 🤖 E-mail automático (no-reply, alerta, newsletter) — RECONHECER. PURO.
//
// 15/09 (GoLink): o Gmail do canal é a caixa inteira da empresa. Quando a
// leitura voltou, entraram 20 e-mails de Google (alerta de segurança),
// Anthropic/OpenAI (recibos de assinatura), Link e Asana — 10 contatos falsos
// e 56 não lidas no inbox da equipe, com recibo à vista de todo mundo.
//
// Só vale nos canais com a opção "Ignorar e-mails automáticos" ligada
// (provider_meta.ignoreAutomated): a conta da Fluxia usa o canal de e-mail
// justamente pra receber os avisos do Asaas.
//
// Sinais:
//   1. cabeçalhos que o próprio remetente põe: Auto-Submitted (≠ no),
//      Precedence bulk/junk, List-Unsubscribe / List-Id;
//   2. endereço de robô: no-reply, noreply-…, nao-responda, notifications@,
//      mailer-daemon, postmaster, bounces, newsletter.
// Cuidados (revisão 15/09):
//   - Grupo do Google / lista da própria empresa (financeiro@ como Grupo do
//     Workspace) põe List-Id, List-Unsubscribe e Precedence: list em e-mail de
//     GENTE — nesses casos cabeçalho de lista não conta;
//   - From de robô com Reply-To de pessoa de outro domínio (aviso de
//     formulário/lead) é pessoa.
// Quem entra mesmo parecendo robô (cliente conhecido): email-automated-filter.ts.
// Aviso de devolução (DSN) não passa por aqui: vira nota (email-bounce.ts).
// ============================================================

export interface EmailHeader {
  key: string
  value: string
}

export interface AutomatedCheckInput {
  from: string
  replyTo?: string | null
  headers?: readonly EmailHeader[]
  /** Endereço do próprio canal — lista do mesmo domínio é grupo interno. */
  channelAddress?: string | null
}

const LOCAL_ROBOT =
  /^(?:no-?reply|do-?not-?reply|donotreply|n[aã]o-?responda|naoresponder|notifica(?:c|ç)(?:o|õ)es|notifications?|alerts?|mailer-daemon|mail-daemon|postmaster|bounces?|newsletters?|news)$/i
/** "noreply-accounts", "no-reply-abc123", "bounces+123", "info-noreply". */
const LOCAL_ROBOT_PART = /(?:^|[-_.+])(?:no-?reply|do-?not-?reply|n[aã]o-?responda|bounces?)(?:[-_.+]|$)/i
/** Reply-To de caixa genérica de empresa (recibo com Reply-To support@) não é pessoa. */
const LOCAL_GENERIC = /^(?:support|suporte|help|ajuda|contato|contact|atendimento|sac|hello|ola|info|billing|faturamento|financeiro|team|equipe)$/i
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/

function header(headers: readonly EmailHeader[] | undefined, key: string): string {
  return (headers ?? []).find((h) => h.key.toLowerCase() === key)?.value?.trim() ?? ''
}

export function domainOf(address: string | null | undefined): string | null {
  const a = (address ?? '').trim().toLowerCase()
  return EMAIL_RE.test(a) ? a.split('@')[1] : null
}

const sameOrSubdomain = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)

function isRobotLocal(address: string): boolean {
  const local = address.trim().toLowerCase().split('@')[0] ?? ''
  if (!local) return false
  // Tira o "+tag": "bounces+123" → "bounces".
  return LOCAL_ROBOT.test(local.split('+')[0]) || LOCAL_ROBOT_PART.test(local)
}

/** Chegou por um Grupo do Google ou por lista da própria empresa (não é robô por isso). */
function isGroupDelivery(headers: readonly EmailHeader[] | undefined, channelAddress: string | null | undefined): boolean {
  if (header(headers, 'x-google-group-id') || header(headers, 'mailing-list')) return true
  const channelDomain = domainOf(channelAddress)
  if (!channelDomain) return false
  // List-Id: "Nome <cobranca.golink.com.br>" → termina com o domínio do canal.
  const listId = header(headers, 'list-id').toLowerCase().match(/<([^>]+)>/)?.[1] ?? ''
  return !!listId && (listId === channelDomain || listId.endsWith(`.${channelDomain}`))
}

/** From de robô que manda responder pra uma PESSOA de outro domínio (formulário, lead). */
function repliesToPerson(from: string, replyTo: string | null | undefined): boolean {
  const reply = (replyTo ?? '').trim().toLowerCase()
  const replyDomain = domainOf(reply)
  const fromDomain = domainOf(from)
  if (!replyDomain || !fromDomain || sameOrSubdomain(replyDomain, fromDomain)) return false
  const local = reply.split('@')[0]
  return !isRobotLocal(reply) && !LOCAL_GENERIC.test(local.split('+')[0])
}

/**
 * Por que este e-mail é automático, ou null (pessoa escrevendo). O motivo vai
 * pro log e pra tela — nunca assunto nem corpo.
 */
export function automatedSenderReason(input: AutomatedCheckInput): string | null {
  const auto = header(input.headers, 'auto-submitted').toLowerCase()
  if (auto && auto !== 'no') return `envio automático (auto-submitted=${auto.split(/[;\s]/)[0]})`
  const precedence = header(input.headers, 'precedence').toLowerCase()
  if (/^(?:bulk|junk)$/.test(precedence)) return `envio em massa (precedence=${precedence})`

  const group = isGroupDelivery(input.headers, input.channelAddress)
  const listHeader = !group && (header(input.headers, 'list-unsubscribe') || header(input.headers, 'list-id'))
  const robotAddress = isRobotLocal(input.from)
  if (!listHeader && !robotAddress) return null
  // Aviso de formulário: From de robô, Reply-To de gente. Cabeçalho de lista
  // (newsletter, recibo) continua valendo mesmo com Reply-To.
  if (!listHeader && repliesToPerson(input.from, input.replyTo)) return null
  if (listHeader) return 'lista ou newsletter (list-unsubscribe)'
  return `remetente de robô (${input.from.trim().toLowerCase().split('@')[0]}@)`
}

/** A opção do canal está ligada? */
export function ignoresAutomatedEmail(providerMeta: unknown): boolean {
  return !!providerMeta && typeof providerMeta === 'object' && (providerMeta as Record<string, unknown>).ignoreAutomated === true
}

/** Webmail público: domínio igual não prova que é o mesmo cliente. */
export const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.com.br', 'outlook.com', 'outlook.com.br', 'live.com',
  'msn.com', 'yahoo.com', 'yahoo.com.br', 'icloud.com', 'me.com', 'uol.com.br', 'bol.com.br', 'terra.com.br',
  'ig.com.br', 'globo.com', 'globomail.com', 'r7.com', 'zoho.com', 'proton.me', 'protonmail.com', 'aol.com',
])

export interface IgnoredAutomatedEntry {
  from: string
  reason: string
  at: string
}

/** Últimos ignorados guardados no provider_meta (pra tela). */
export function ignoredAutomatedOf(providerMeta: unknown): { count: number; recent: IgnoredAutomatedEntry[] } {
  const m = providerMeta && typeof providerMeta === 'object' ? (providerMeta as Record<string, unknown>) : {}
  const count = typeof m.ignoredAutomatedCount === 'number' ? m.ignoredAutomatedCount : 0
  const list = Array.isArray(m.ignoredAutomated) ? m.ignoredAutomated : []
  const recent = list
    .filter((e): e is IgnoredAutomatedEntry => !!e && typeof e === 'object' && typeof (e as IgnoredAutomatedEntry).from === 'string')
    .map((e) => ({ from: e.from, reason: String(e.reason ?? ''), at: String(e.at ?? '') }))
  return { count, recent }
}
