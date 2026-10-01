// ============================================================
// Canal fora do ar — o que dizer na tela. PURO (client-safe: o banner global
// importa daqui; a rota /api/channels/status e a de envio também).
//
// 01/10, 15:30: a Meta invalidou o token do Instagram de um cliente (erro
// 190, "The session has been invalidated because the user changed their
// password or Facebook has changed the session for security reasons"). O
// monitor (instagram-health.ts → markIgChannelExpired) fez a parte dele:
// status='disconnected' + provider_meta.health = { state: 'needs_reconnect',
// reason }. Mas ninguém via:
//   1. o aviso vermelho global só olhava canais de QR — Instagram, Messenger e
//      WhatsApp oficial (canais de TOKEN) nunca apareciam;
//   2. o atendente só via "erro de envio" na bolha, sem saber que o remédio
//      era reconectar.
// Aqui ficam as três decisões, testáveis sem banco: o motivo em PT curto, quais
// canais o banner mostra, e quando o erro de envio vira "canal desconectado".
//
// ⚠️ Nada daqui devolve o texto cru da Meta: ele pode trazer fbtrace_id, ids
// de conta e afins. Só frases fixas saem para a tela (lida por TODA a equipe).
// ============================================================

import { CAPABILITIES, type ProviderId } from './provider'

/** Canais que vivem de um token da Meta (sem QR, sem sessão de aparelho). */
export const TOKEN_PROVIDERS = ['instagram', 'messenger', 'meta'] as const
export type TokenProviderId = (typeof TOKEN_PROVIDERS)[number]

export function isTokenProvider(provider: string | null | undefined): provider is TokenProviderId {
  return (TOKEN_PROVIDERS as readonly string[]).includes(provider ?? '')
}

/** Como o banner chama cada canal de token. */
export const TOKEN_PROVIDER_LABEL: Record<TokenProviderId, string> = {
  instagram: 'Instagram',
  messenger: 'Messenger',
  meta: 'WhatsApp oficial',
}

/** As três frases possíveis — o banner é lido por atendente, não por técnico. */
export const META_REASON = {
  /** 190 / sessão invalidada (senha trocada, sessão encerrada pela Meta). */
  sessionInvalidated: 'a senha foi trocada ou o Facebook encerrou a sessão por segurança',
  /** Token vencido (o de 60 dias do Instagram, o temporário do WhatsApp). */
  expired: 'o acesso venceu',
  /** Qualquer outro motivo (ou nenhum motivo gravado). */
  refused: 'a Meta recusou o acesso',
} as const

// A Meta escreve na língua da conta de quem conectou: casamos inglês E
// português. O monitor do WhatsApp oficial (meta-health.ts) grava o motivo já
// em PT ("token de acesso inválido ou expirado (190)").
const SESSION_INVALIDATED_RE =
  /session has been invalidated|changed (?:their|the) password|changed the session|subcode=460\b|sess[aã]o foi invalidada|(?:alterou|trocou|mudou) a senha/i
const EXPIRED_RE =
  /session has expired|has expired|token (?:has )?expired|subcode=463\b|sess[aã]o expirou|\bexpirou\b|token vencido|\bvenceu\b/i
const TOKEN_190_RE =
  /\bcode=190\b|\(#?190\)|\b190\b|error validating access token|invalid oauth (?:2\.0 )?access token/i

/**
 * Motivo da Meta (texto cru do Graph, ou o que o monitor gravou) → frase curta.
 *
 * A ordem importa: "Error validating access token: Session has expired…" tem
 * as duas coisas — o vencimento é o que diz ao dono o que aconteceu. Sem nada
 * reconhecível (ou sem motivo gravado), a frase genérica.
 */
export function metaReasonPt(raw: string | null | undefined): string {
  const text = (raw ?? '').trim()
  if (!text) return META_REASON.refused
  if (SESSION_INVALIDATED_RE.test(text)) return META_REASON.sessionInvalidated
  if (EXPIRED_RE.test(text)) return META_REASON.expired
  if (TOKEN_190_RE.test(text)) return META_REASON.sessionInvalidated
  return META_REASON.refused
}

interface TokenHealth {
  /** Instagram (instagram-health.ts): 'ok' | 'warn' | 'needs_reconnect'. */
  state?: unknown
  /** Instagram: o erro da Meta que derrubou o canal. */
  reason?: unknown
  /** WhatsApp oficial (meta-health.ts): motivo do último 'dead'. */
  last_error?: unknown
  /** WhatsApp oficial (meta-health.ts): o MONITOR derrubou o canal. */
  marked_down?: unknown
}

function healthOf(providerMeta: unknown): TokenHealth {
  if (!providerMeta || typeof providerMeta !== 'object') return {}
  const health = (providerMeta as Record<string, unknown>).health
  return health && typeof health === 'object' ? (health as TokenHealth) : {}
}

export interface ChannelHealthInput {
  provider: string
  status: string
  providerMeta: unknown
}

/**
 * O canal de token foi derrubado pela Meta?
 *   Instagram / Messenger → status fora de 'connected' (o monitor do token e o
 *     "app removido" no Instagram só gravam o status) ou health
 *     'needs_reconnect';
 *   WhatsApp oficial → SÓ a marca do monitor (health.marked_down). O status
 *     sozinho não serve: o oficial com registro de número que falhou fica
 *     'disconnected' de propósito (o meta-health o ignora) e o `channel-halt`
 *     da cobrança marca 'error' por reputação — o banner acusaria "desconectado
 *     pela Meta" para sempre numa conta que não pediu nada (revisão de 01/10).
 */
export function isTokenChannelDown(ch: ChannelHealthInput): boolean {
  if (!isTokenProvider(ch.provider)) return false
  const h = healthOf(ch.providerMeta)
  if (h.state === 'needs_reconnect') return true
  if (ch.provider === 'meta') return h.marked_down === true
  return ch.status !== 'connected'
}

/** O motivo que o monitor gravou é recusa de TOKEN (senha, sessão, 190)? */
function recordedTokenFailure(ch: ChannelHealthInput): boolean {
  const h = healthOf(ch.providerMeta)
  const raw = typeof h.reason === 'string' ? h.reason : typeof h.last_error === 'string' ? h.last_error : ''
  return h.state === 'needs_reconnect' || looksLikeChannelAuthFailure(raw)
}

/**
 * Frase do banner para um canal de token fora do ar — null quando está bem
 * (ou quando não é canal de token). O status pode continuar 'connected' com
 * o monitor já sabendo que o token morreu: a saúde também conta.
 */
export function tokenChannelProblem(ch: ChannelHealthInput): string | null {
  if (!isTokenChannelDown(ch)) return null
  const h = healthOf(ch.providerMeta)
  const raw =
    typeof h.reason === 'string' && h.reason.trim()
      ? h.reason
      : typeof h.last_error === 'string'
        ? h.last_error
        : null
  return metaReasonPt(raw)
}

/**
 * Título da linha do banner. O nome do canal costuma já dizer o que ele é
 * ("Instagram @loja", "Messenger — Página", "WhatsApp (Meta)"): aí o rótulo
 * sairia repetido ("Instagram Instagram @loja") e fica de fora.
 */
export function tokenBannerLabel(provider: TokenProviderId, name: string): string | null {
  const label = TOKEN_PROVIDER_LABEL[provider]
  const firstWord = label.split(' ')[0].toLowerCase()
  return name.toLowerCase().includes(firstWord) ? null : label
}

export interface BannerChannel {
  provider: string
  status: string
  problem?: string | null
}

/**
 * Quais canais o banner global mostra, em três grupos:
 *  - qrDown: canais de QR (WAHA/Evolution/EvoGo) com a sessão caída — o
 *    "Reconectar" abre o modal de QR, que só esses suportam;
 *  - gmailBroken: Gmail com problema de saúde (fica 'connected' no banco);
 *  - tokenDown: Instagram/Messenger/WhatsApp oficial com `problem` — a rota
 *    só preenche quando o canal caiu ou precisa reconectar.
 * Nenhum canal cai em dois grupos.
 */
export function selectBannerChannels<T extends BannerChannel>(
  list: T[],
): { qrDown: T[]; gmailBroken: T[]; tokenDown: T[] } {
  return {
    qrDown: list.filter(
      (c) => c.status !== 'connected' && !!CAPABILITIES[c.provider as ProviderId]?.qrPairing,
    ),
    gmailBroken: list.filter((c) => c.provider === 'gmail' && !!c.problem),
    tokenDown: list.filter((c) => isTokenProvider(c.provider) && !!c.problem),
  }
}

// ------------------------------------------------------------
// Erro de envio → "o canal está desconectado".
// ------------------------------------------------------------

// Recusa de TOKEN no envio. Os adaptadores escrevem cada um de um jeito:
//   instagram: "instagram send falhou: 401 <msg> [code=190 subcode=460 …]"
//   messenger: "messenger send falhou: 401 <msg>"
//   meta:      só a <msg> da Graph
// e o canal sem token nenhum lança "sem credentials.accessToken" (IG/Messenger)
// ou "is missing credentials.accessToken" (meta).
const AUTH_FAILURE_RE =
  /\bcode=190\b|\(#190\)|error validating access token|invalid oauth (?:2\.0 )?access token|session has been invalidated|session has expired|access token has expired|has not authorized application|(?:sem|missing) credentials\.accessToken/i

/** O texto do erro de envio é a Meta recusando o token do canal? */
export function looksLikeChannelAuthFailure(message: string | null | undefined): boolean {
  return AUTH_FAILURE_RE.test(message ?? '')
}

/** A frase que o atendente lê no lugar do erro genérico. */
export function channelDisconnectedMessage(name: string): string {
  const nome = name.trim()
  return nome
    ? `O canal ${nome} está desconectado — reconecte em Configurações → Canais.`
    : 'O canal desta conversa está desconectado — reconecte em Configurações → Canais.'
}

export interface SendFailureInput {
  /** `SendMessageError.code`. */
  errorCode: string
  /** `SendMessageError.message` (já passou pelo friendlySendError). */
  errorMessage: string
  /** O canal da conversa (null quando não deu para ler). */
  channel: (ChannelHealthInput & { name: string }) | null
}

/**
 * O envio falhou porque o canal está desconectado / sem token válido? Devolve
 * a frase para a tela, ou null para manter o erro original.
 *
 * Só falha do PROVEDOR entra ('send_error'; 'channel_disconnected' fica
 * reservado para quando o núcleo de envio já souber dizer). Validação,
 * "template só no oficial" e, principalmente, 'db_error' (a mensagem SAIU e só
 * não foi gravada) nunca viram "desconectado".
 *
 * Canal de QR com status caído só troca o erro GENÉRICO ("waha send error: …"):
 * o status de sessão pode estar velho, e uma frase específica ("Este número
 * não parece estar no WhatsApp") vale mais que um palpite. Canal de token
 * marcado pelo monitor troca qualquer falha — com o token morto, nada sai.
 * E-mail/Gmail ficam de fora: têm frase própria (senha de app, domínio).
 */
export function disconnectedSendMessage(input: SendFailureInput): string | null {
  const { errorCode, errorMessage, channel } = input
  if (errorCode !== 'send_error' && errorCode !== 'channel_disconnected') return null
  if (!channel) return null
  if (errorCode === 'channel_disconnected') return channelDisconnectedMessage(channel.name)

  if (isTokenProvider(channel.provider)) {
    // Canal caído por banimento/bloqueio/reputação NÃO vira "reconecte": a
    // falha específica (ex.: parâmetro do modelo) é mais útil e reconectar
    // não resolve. Só troca quando o erro — ou o motivo que o monitor gravou —
    // é recusa de token (revisão de 01/10).
    if (
      looksLikeChannelAuthFailure(errorMessage) ||
      (isTokenChannelDown(channel) && recordedTokenFailure(channel))
    ) {
      return channelDisconnectedMessage(channel.name)
    }
    return null
  }

  const qr = !!CAPABILITIES[channel.provider as ProviderId]?.qrPairing
  if (qr && channel.status !== 'connected') {
    const generic = errorMessage.toLowerCase().startsWith(`${channel.provider} send error:`)
    if (generic) return channelDisconnectedMessage(channel.name)
  }
  return null
}
