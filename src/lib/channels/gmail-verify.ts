// ============================================================
// Testa uma senha de app do Gmail NOS DOIS caminhos que o canal usa:
//   SMTP (smtp.gmail.com:465) — envio;
//   IMAP (imap.gmail.com:993) — leitura da caixa (poll do worker).
//
// 15/09 (GoLink): o Google revogou a senha de app às 23:13 de 14/09. Pra
// consertar, o admin cola uma senha nova e a gente só grava se o Google
// aceitar — senão o canal ficaria "conectado" com senha errada de novo. Testar
// só o SMTP não basta: a leitura pode ser recusada mesmo com o envio ok.
//
// ⚠️ Importado SÓ pela troca de senha (gmail-credentials.ts / rota). NUNCA por
// providers/gmail.ts: aquele é carregado pelo registry em ~18 rotas e o
// imapflow (pino, sockets) não pode entrar nesse grafo.
//
// Nunca loga nem devolve a senha, nem o comando IMAP de login.
// ============================================================

import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'

export type GmailVerifyKind = 'auth' | 'network'
export type GmailVerifyStep = 'smtp' | 'imap'

/** Falha da verificação, já classificada. `code` é só pra log (sem segredo). */
export class GmailVerifyError extends Error {
  readonly kind: GmailVerifyKind
  readonly step: GmailVerifyStep
  readonly code: string | null

  constructor(kind: GmailVerifyKind, step: GmailVerifyStep, code: string | null) {
    super(`gmail ${step}: ${kind === 'auth' ? 'login recusado' : 'sem resposta'}${code ? ` (${code})` : ''}`)
    this.name = 'GmailVerifyError'
    this.kind = kind
    this.step = step
    this.code = code
  }
}

const CONNECTION_TIMEOUT_MS = 15_000
const GREETING_TIMEOUT_MS = 10_000
const SOCKET_TIMEOUT_MS = 30_000

/** Mesma normalização da criação do canal (api/channels POST). */
export function normalizeGmailAddress(address: string): string {
  return address.trim().toLowerCase()
}
export function normalizeAppPassword(appPassword: string): string {
  // O Google mostra a senha em grupos de 4 com espaços.
  return appPassword.replace(/\s+/g, '')
}

type MailError = {
  authenticationFailed?: boolean
  serverResponseCode?: string
  code?: string
  responseCode?: number
}

/** Mesmo critério de "senha recusada" do classifyGmailError (gmail-health.ts). */
function isAuthError(err: unknown): boolean {
  const e = (err ?? {}) as MailError
  // 454/421 (muitas tentativas, problema temporário): o nodemailer manda como
  // EAUTH, mas não é senha errada — vira "tente de novo em alguns minutos".
  if (typeof e.responseCode === 'number' && e.responseCode >= 400 && e.responseCode < 500) return false
  return (
    e.authenticationFailed === true ||
    e.serverResponseCode === 'AUTHENTICATIONFAILED' ||
    e.responseCode === 534 ||
    e.responseCode === 535 ||
    (e.code === 'EAUTH' && typeof e.responseCode !== 'number')
  )
}

/** Código curto pro log: nunca message/executedCommand (podem trazer o login). */
function safeCode(err: unknown): string | null {
  const e = (err ?? {}) as MailError
  return e.serverResponseCode || e.code || (e.responseCode ? String(e.responseCode) : null)
}

function toVerifyError(err: unknown, step: GmailVerifyStep): GmailVerifyError {
  if (err instanceof GmailVerifyError) return err
  return new GmailVerifyError(isAuthError(err) ? 'auth' : 'network', step, safeCode(err))
}

/** Login SMTP. Lança GmailVerifyError. */
export async function verifyGmailSmtp(address: string, appPassword: string): Promise<void> {
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: normalizeGmailAddress(address), pass: normalizeAppPassword(appPassword) },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  })
  try {
    await transport.verify()
  } catch (err) {
    throw toVerifyError(err, 'smtp')
  } finally {
    transport.close()
  }
}

/**
 * Login IMAP + STATUS da INBOX (sem SELECT: não mexe em "lida"/recente).
 * Devolve a época de UIDs e o próximo UID — quem troca a senha compara com o
 * ponto de leitura salvo. Lança GmailVerifyError.
 */
export async function verifyGmailImap(
  address: string,
  appPassword: string,
): Promise<{ uidValidity: string; uidNext: number }> {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: normalizeGmailAddress(address), pass: normalizeAppPassword(appPassword) },
    logger: false,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  })
  // Lição do incidente (gmail-poll.ts): login recusado rejeita o connect() mas
  // deixa o socket aberto; o timeout depois vira 'error' sem ouvinte e derruba
  // o processo. Ouvinte SEMPRE + close() no connect falho.
  client.on('error', (err: Error & { code?: string }) => {
    console.warn('[gmail-verify] imap error code=%s', err?.code ?? 'desconhecido')
  })

  try {
    await client.connect()
  } catch (err) {
    try {
      client.close()
    } catch {
      /* já fechado */
    }
    throw toVerifyError(err, 'imap')
  }

  try {
    const st = await client.status('INBOX', { uidValidity: true, uidNext: true })
    if (st.uidValidity === undefined || st.uidValidity === null || !st.uidNext) {
      throw new GmailVerifyError('network', 'imap', 'STATUS_INCOMPLETO')
    }
    return { uidValidity: String(st.uidValidity), uidNext: Number(st.uidNext) }
  } catch (err) {
    throw toVerifyError(err, 'imap')
  } finally {
    try {
      if (client.usable) await client.logout()
      else client.close()
    } catch {
      client.close()
    }
  }
}
