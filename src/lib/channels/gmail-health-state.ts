// ============================================================
// Saúde do canal Gmail — formato e leitura. PURO (client-safe).
//
// 15/09 (GoLink): o Google recusou a senha de app às 23:13 de 14/09 e o canal
// seguiu verde "conectado" — ninguém soube. A saúde fica em
// provider_meta.health, POR ORIGEM:
//   imap — leitura da caixa (gmail-poll, no worker);
//   smtp — envio (send-message/disparo, na web ou no worker).
// Um sucesso só zera a SUA origem: SMTP funcionando não prova que o IMAP
// voltou (e zerar tudo faria o aviso repetir a cada envio).
//
// NÃO mexe em channels.status: o poll só lê canais 'connected', e o canal
// precisa continuar sendo tentado pra se recuperar sozinho.
//
// Gravação (merge jsonb, avisos): gmail-health.ts.
// ============================================================

export type GmailHealthSource = 'imap' | 'smtp'
export type GmailFailureVerdict = 'auth_failed' | 'error'

export interface GmailSourceHealth {
  verdict: GmailFailureVerdict
  /** Motivo curto, sem senha nem comando IMAP. */
  error: string
  /** Falhas seguidas desde a última vez que funcionou. */
  strikes: number
  first_fail_at: string
  last_at: string
}

export interface GmailHealth {
  imap?: GmailSourceHealth
  smtp?: GmailSourceHealth
  /** Já avisamos dono/admins deste incidente (1 aviso por incidente). */
  alerted_incident?: boolean
  alerted_at?: string | null
}

/** Erro que não é senha só vira problema depois de 30 falhas E 30 min. */
export const GMAIL_FAILS_TO_ALERT = 30
export const GMAIL_MIN_FAIL_WINDOW_MS = 30 * 60_000

function isSourceHealth(v: unknown): v is GmailSourceHealth {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return (s.verdict === 'auth_failed' || s.verdict === 'error') && typeof s.first_fail_at === 'string'
}

export function gmailHealthOf(providerMeta: unknown): GmailHealth | null {
  if (!providerMeta || typeof providerMeta !== 'object') return null
  const h = (providerMeta as Record<string, unknown>).health
  if (!h || typeof h !== 'object') return null
  const raw = h as Record<string, unknown>
  const out: GmailHealth = {}
  if (isSourceHealth(raw.imap)) out.imap = raw.imap
  if (isSourceHealth(raw.smtp)) out.smtp = raw.smtp
  if (typeof raw.alerted_incident === 'boolean') out.alerted_incident = raw.alerted_incident
  if (typeof raw.alerted_at === 'string') out.alerted_at = raw.alerted_at
  return out
}

function sourceIsProblem(s: GmailSourceHealth | undefined, now: number): boolean {
  if (!s) return false
  if (s.verdict === 'auth_failed') return true
  const since = Date.parse(s.first_fail_at)
  return s.strikes >= GMAIL_FAILS_TO_ALERT && Number.isFinite(since) && now - since >= GMAIL_MIN_FAIL_WINDOW_MS
}

export interface GmailProblem {
  kind: GmailFailureVerdict
  source: GmailHealthSource
  /** Frase pronta pra tela. */
  message: string
  since: string
}

/**
 * O canal está com problema que merece aviso/selo vermelho? Senha recusada
 * (em qualquer origem) vence erro genérico. null = sem problema.
 */
export function gmailProblem(health: GmailHealth | null | undefined, now = Date.now()): GmailProblem | null {
  if (!health) return null
  const sources: GmailHealthSource[] = ['imap', 'smtp']
  for (const source of sources) {
    const s = health[source]
    if (s?.verdict === 'auth_failed') {
      return {
        kind: 'auth_failed',
        source,
        message: 'O Google recusou a senha de app. Gere uma nova e troque aqui.',
        since: s.first_fail_at,
      }
    }
  }
  for (const source of sources) {
    const s = health[source]
    if (s && sourceIsProblem(s, now)) {
      return {
        kind: 'error',
        source,
        message: source === 'imap' ? `Não conseguimos ler a caixa (${s.error}).` : `Os envios estão falhando (${s.error}).`,
        since: s.first_fail_at,
      }
    }
  }
  return null
}

/** A régua/envio automático não deve tentar este Gmail (senha recusada). */
export function gmailSendBlockedReason(providerMeta: unknown): string | null {
  const p = gmailProblem(gmailHealthOf(providerMeta))
  return p?.kind === 'auth_failed'
    ? 'a senha de app do Gmail foi recusada pelo Google — um admin precisa trocar em Configurações → Canais'
    : null
}
