// ============================================================
// Saúde do canal Gmail — gravação e aviso. Worker-reachable (sem
// 'server-only'). Formato e leitura: gmail-health-state.ts.
//
// 15/09 (GoLink): o Google recusou a senha de app às 23:13 de 14/09. O poll
// falhava em silêncio, a régua de cobrança por e-mail parou, o canal seguiu
// verde e ninguém soube até a manhã. Aqui:
//   • cada falha grava provider_meta.health.<origem> por MERGE jsonb atômico
//     (web e worker escrevem o mesmo campo; objeto lido antes = apaga o do
//     outro);
//   • senha recusada avisa NA HORA; outro erro só depois de 30 falhas E 30 min
//     (regra em gmailProblem);
//   • 1 aviso por incidente: quem grava alerted_incident=true primeiro (UPDATE
//     condicional) é quem avisa — poll e envio podem detectar juntos;
//   • um sucesso zera só a SUA origem; quando não sobra nenhuma, o incidente
//     fecha e, se tinha avisado, avisa "voltou" (também reservado).
//
// Decisões:
//   • strikes NÃO zeram quando o tipo muda (timeout → senha): contam falhas
//     seguidas desde a última vez que funcionou; first_fail_at idem. Só um
//     sucesso da origem apaga a entrada.
//   • escalada: incidente avisado como "falha" que vira "senha recusada" avisa
//     DE NOVO (a ação muda: agora alguém precisa trocar a senha). Guardado em
//     health.alerted_kind.
//   • anti-flap: erro genérico que volta a estourar menos de 6 h depois do
//     último aviso de um incidente JÁ ENCERRADO não reavisa (o banner mostra
//     do mesmo jeito). Senha recusada sempre avisa — é afirmação do Google, não
//     oscilação, e o poll já espera 30 min entre logins. Pra lembrar o
//     alerted_at, o incidente encerrado deixa health = { alerted_at } por até
//     6 h; depois disso o próximo encerramento limpa tudo.
//
// Nunca lança. Nunca loga senha, credentials nem o comando IMAP.
// ============================================================

import { and, eq, sql } from 'drizzle-orm'

import { db, channels, organization } from '@/db'
import { publishEvent } from '@/lib/events/publish'
import { alertPlatform, notifyChannelAdmins } from '@/lib/alerts/channel-alert'
import {
  gmailHealthOf,
  gmailProblem,
  type GmailFailureVerdict,
  type GmailHealth,
  type GmailHealthSource,
  type GmailProblem,
} from './gmail-health-state'

/** Janela do anti-flap pra erro genérico (ver cabeçalho). */
export const GMAIL_REALERT_COOLDOWN_MS = 6 * 60 * 60_000

// ------------------------------------------------------------
// Classificação do erro (imapflow / nodemailer)
// ------------------------------------------------------------

type MailError = {
  authenticationFailed?: boolean
  serverResponseCode?: string
  code?: string
  responseCode?: number
  responseText?: string
  response?: string
  message?: string
}

/** Texto do Gmail que é recusa de login DE VERDADE (IMAP "[AUTHENTICATIONFAILED]
 *  Invalid credentials", SMTP "535-5.7.8 Username and Password not accepted",
 *  "534-5.7.9 Application-specific password required"). NÃO inclui o "Invalid
 *  login" puro: o nodemailer põe isso em QUALQUER recusa do AUTH, inclusive o
 *  temporário "454 4.7.0 Too many login attempts". */
const AUTH_TEXT =
  /authenticationfailed|invalid credentials|username and password not accepted|application-specific password required|missing credentials|\b53[45][- ]5\.7\./i

const TIMEOUT_CODES = new Set([
  'ETIMEOUT',
  'ETIMEDOUT',
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'LockTimeout',
])
const CONNECTION_CODES = new Set([
  'NoConnection',
  'EConnectionClosed',
  'ClosedAfterConnectTLS',
  'ClosedAfterConnectText',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNECTION',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'ESOCKET',
])

/** Corta qualquer coisa a partir de um comando de login (pode carregar a senha). */
function redact(text: string): string {
  return text
    .replace(/\b(LOGIN|AUTHENTICATE|AUTH\s+(PLAIN|LOGIN|XOAUTH2))\b[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Classifica o erro do imapflow/nodemailer. Nunca inclui senha nem comando IMAP. */
export function classifyGmailError(err: unknown): { verdict: GmailFailureVerdict; reason: string } {
  const e: MailError = err && typeof err === 'object' ? (err as MailError) : { message: String(err ?? '') }
  const text = [e.message, e.responseText, e.response].filter((s) => typeof s === 'string').join(' ')
  // Recusa TEMPORÁRIA do SMTP (454 "Too many login attempts", 421): o nodemailer
  // manda como EAUTH, mas a senha pode estar boa — não é "senha recusada".
  if (typeof e.responseCode === 'number' && e.responseCode >= 400 && e.responseCode < 500) {
    return { verdict: 'error', reason: 'o Gmail limitou os logins por um tempo' }
  }
  if (
    e.authenticationFailed === true ||
    e.serverResponseCode === 'AUTHENTICATIONFAILED' ||
    e.responseCode === 534 ||
    e.responseCode === 535 ||
    // EAUTH sem código de resposta = faltou credencial (nodemailer "Missing credentials").
    (e.code === 'EAUTH' && typeof e.responseCode !== 'number') ||
    AUTH_TEXT.test(text)
  ) {
    return { verdict: 'auth_failed', reason: 'o Google recusou a senha de app' }
  }
  const code = typeof e.code === 'string' ? e.code : ''
  if (TIMEOUT_CODES.has(code) || /timed? ?out/i.test(e.message ?? '')) {
    return { verdict: 'error', reason: 'o Gmail demorou demais para responder' }
  }
  if (code === 'ETHROTTLE' || /too many simultaneous connections|too many connections/i.test(text)) {
    return { verdict: 'error', reason: 'o Gmail limitou o acesso (conexões demais)' }
  }
  if (CONNECTION_CODES.has(code)) {
    return { verdict: 'error', reason: 'a conexão com o Gmail caiu' }
  }
  if (/sem endereço ou senha de app|sem credentials\./i.test(e.message ?? '')) {
    return { verdict: 'error', reason: 'o canal está sem endereço ou senha de app salvos' }
  }
  const raw = redact(String(e.responseText || e.response || e.message || code || ''))
  return { verdict: 'error', reason: (raw || 'erro desconhecido').slice(0, 120) }
}

// ------------------------------------------------------------
// Decisões PURAS (testáveis sem banco)
// ------------------------------------------------------------

function rawHealth(providerMeta: unknown): Record<string, unknown> | null {
  if (!providerMeta || typeof providerMeta !== 'object') return null
  const h = (providerMeta as Record<string, unknown>).health
  return h && typeof h === 'object' && !Array.isArray(h) ? (h as Record<string, unknown>) : null
}

function hasSourceEntry(providerMeta: unknown, source: GmailHealthSource): boolean {
  const h = rawHealth(providerMeta)
  return !!h && h[source] != null
}

function addressOf(providerMeta: unknown): string | null {
  const a = providerMeta && typeof providerMeta === 'object' ? (providerMeta as Record<string, unknown>).address : null
  return typeof a === 'string' && a ? a : null
}

function isSource(s: unknown): s is GmailHealthSource {
  return s === 'imap' || s === 'smtp'
}

/** Hora da última falha gravada (qualquer origem) — quando a tela viu o estado. */
function lastWriteAt(h: GmailHealth | null): number | null {
  const ts = [h?.imap?.last_at, h?.smtp?.last_at].map((s) => (s ? Date.parse(s) : NaN)).filter(Number.isFinite)
  return ts.length ? Math.max(...ts) : null
}

/**
 * O canal entrou ou saiu de "com problema" nesta escrita? (dispara o
 * channel_status pra tela atualizar sem F5.) O antes é avaliado na hora da
 * última escrita E agora: erro genérico vira problema pelo relógio (30 min),
 * sem escrita no meio.
 */
export function problemChanged(before: unknown, after: unknown, now = Date.now()): boolean {
  const b = gmailHealthOf(before)
  const hasAfter = !!gmailProblem(gmailHealthOf(after), now)
  const prevAt = lastWriteAt(b) ?? now
  return hasAfter !== !!gmailProblem(b, prevAt) || hasAfter !== !!gmailProblem(b, now)
}

export type IncidentAlertDecision =
  | { alert: true; problem: GmailProblem; escalation: boolean }
  | { alert: false; why: 'no_problem' | 'already_alerted' | 'anti_flap' }

/** Avisar agora? (a reserva atômica no banco confirma depois.) */
export function decideIncidentAlert(providerMeta: unknown, now = Date.now()): IncidentAlertDecision {
  const health = gmailHealthOf(providerMeta)
  const problem = gmailProblem(health, now)
  if (!health || !problem) return { alert: false, why: 'no_problem' }
  if (health.alerted_incident) {
    const alertedKind = rawHealth(providerMeta)?.alerted_kind
    if (problem.kind === 'auth_failed' && alertedKind === 'error') {
      return { alert: true, problem, escalation: true }
    }
    return { alert: false, why: 'already_alerted' }
  }
  if (problem.kind === 'error' && health.alerted_at) {
    const last = Date.parse(health.alerted_at)
    if (Number.isFinite(last) && now - last < GMAIL_REALERT_COOLDOWN_MS) return { alert: false, why: 'anti_flap' }
  }
  return { alert: true, problem, escalation: false }
}

function formatSince(sinceIso: string, now: number): string {
  const ms = now - Date.parse(sinceIso)
  const min = Number.isFinite(ms) ? Math.max(1, Math.floor(ms / 60_000)) : 30
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h`
  return `${Math.floor(h / 24)} dias`
}

/** Título se basta sozinho: a lista mostra o corpo truncado em 1 linha. */
export function incidentAlertText(
  input: { channelName: string; address: string | null; problem: GmailProblem; health: GmailHealth },
  now = Date.now(),
): { title: string; body: string } {
  const { channelName, problem, health } = input
  const addr = input.address ?? 'este Gmail'
  if (problem.kind === 'auth_failed') {
    return {
      title: `🔴 Gmail "${channelName}" parou: senha de app recusada`,
      body:
        problem.source === 'imap'
          ? `O Google recusou a senha de app de ${addr}. E-mails novos não entram no CRM e os envios por este Gmail (inclusive a régua de cobrança) ficam parados. Gere uma senha de app nova e troque em Configurações → Canais.`
          : `O Google recusou a senha de app de ${addr} no envio. Os e-mails que saem por este Gmail (inclusive a régua de cobrança) ficam parados. Gere uma senha de app nova e troque em Configurações → Canais.`,
    }
  }
  const reason = health[problem.source]?.error ?? 'erro desconhecido'
  return {
    title: `⚠️ Gmail "${channelName}" com falha há ${formatSince(problem.since, now)}`,
    body:
      problem.source === 'imap'
        ? `Não conseguimos ler a caixa de ${addr} (${reason}). E-mails novos podem não estar entrando no CRM. O CRM segue tentando sozinho; se não voltar, confira o canal em Configurações → Canais.`
        : `Os envios por ${addr} estão falhando (${reason}). O CRM segue tentando sozinho; se não voltar, confira o canal em Configurações → Canais.`,
  }
}

export function recoveryAlertText(channelName: string, address: string | null): { title: string; body: string } {
  return {
    title: `✅ Gmail "${channelName}" voltou a funcionar`,
    body: `${address ?? 'O Gmail'} está funcionando de novo: os e-mails novos voltam a entrar no CRM e os envios por ele foram liberados.`,
  }
}

// ------------------------------------------------------------
// Banco — tudo por jsonb no próprio UPDATE (nunca objeto lido + spread).
// Exposto como objeto só pra os testes trocarem por um banco em memória.
// ------------------------------------------------------------

/** Caminhos literais por origem (lista fechada — nunca texto de fora no SQL). */
const SRC_SQL = {
  imap: { path: sql.raw(`'{health,imap}'`), key: sql.raw(`'imap'`) },
  smtp: { path: sql.raw(`'{health,smtp}'`), key: sql.raw(`'smtp'`) },
} as const

export interface GmailHealthWriteRow {
  accountId: string
  name: string
  status: string
  before: unknown
  after: unknown
}

type RawWriteRow = { account_id: string; name: string; status: string; before: unknown; after: unknown }

function toWriteRow(rows: unknown[]): GmailHealthWriteRow | null {
  const r = rows[0] as RawWriteRow | undefined
  return r ? { accountId: r.account_id, name: r.name, status: r.status, before: r.before, after: r.after } : null
}

export interface PreviousAlertMarks {
  alerted_incident?: unknown
  alerted_at?: unknown
  alerted_kind?: unknown
}

export const gmailHealthDb = {
  /** health.<origem> = falha nova (strikes+1, first_fail_at mantido). Devolve antes/depois. */
  async applyFailure(
    channelId: string,
    source: GmailHealthSource,
    verdict: GmailFailureVerdict,
    reason: string,
    nowIso: string,
  ): Promise<GmailHealthWriteRow | null> {
    const { path, key } = SRC_SQL[source]
    const res = await db.execute(sql`
      UPDATE channels AS c
      SET provider_meta = jsonb_set(
        jsonb_set(
          c.provider_meta,
          '{health}',
          CASE WHEN jsonb_typeof(c.provider_meta->'health') = 'object'
            THEN c.provider_meta->'health' ELSE '{}'::jsonb END,
          true
        ),
        ${path},
        jsonb_build_object(
          'verdict', ${verdict}::text,
          'error', ${reason}::text,
          'strikes', (CASE WHEN jsonb_typeof(c.provider_meta->'health'->${key}->'strikes') = 'number'
            THEN (c.provider_meta->'health'->${key}->>'strikes')::numeric::int ELSE 0 END) + 1,
          'first_fail_at', coalesce(c.provider_meta->'health'->${key}->>'first_fail_at', ${nowIso}::text),
          'last_at', ${nowIso}::text
        ),
        true
      )
      FROM (SELECT id, provider_meta FROM channels WHERE id = ${channelId}::uuid FOR UPDATE) AS prev
      WHERE c.id = prev.id AND c.provider = 'gmail'
      RETURNING c.account_id, c.name, c.status, prev.provider_meta AS before, c.provider_meta AS after
    `)
    return toWriteRow(res.rows)
  },

  /** Reserva o aviso do incidente. true = esta chamada avisa; false = outra já avisou. */
  async reserveIncidentAlert(
    channelId: string,
    source: GmailHealthSource,
    kind: GmailFailureVerdict,
    nowIso: string,
  ): Promise<boolean> {
    const { key } = SRC_SQL[source]
    // Senha recusada também passa por cima de um aviso anterior de "falha".
    const notAlerted =
      kind === 'auth_failed'
        ? sql`(coalesce(provider_meta->'health'->>'alerted_incident', 'false') <> 'true'
              OR provider_meta->'health'->>'alerted_kind' = 'error')`
        : sql`coalesce(provider_meta->'health'->>'alerted_incident', 'false') <> 'true'`
    const res = await db.execute(sql`
      UPDATE channels
      SET provider_meta = jsonb_set(
        provider_meta,
        '{health}',
        (provider_meta->'health') || jsonb_build_object(
          'alerted_incident', true,
          'alerted_at', ${nowIso}::text,
          'alerted_kind', ${kind}::text
        )
      )
      WHERE id = ${channelId}::uuid AND provider = 'gmail'
        AND jsonb_typeof(provider_meta->'health') = 'object'
        AND provider_meta->'health'->${key} IS NOT NULL
        AND ${notAlerted}
      RETURNING id
    `)
    return res.rows.length > 0
  },

  /** Aviso não saiu: devolve as marcas de antes pra próxima falha tentar de novo. */
  async releaseIncidentAlert(channelId: string, previous: PreviousAlertMarks): Promise<void> {
    const keep: Record<string, unknown> = {}
    for (const k of ['alerted_incident', 'alerted_at', 'alerted_kind'] as const) {
      if (previous[k] != null) keep[k] = previous[k]
    }
    await db.execute(sql`
      UPDATE channels
      SET provider_meta = jsonb_set(
        provider_meta,
        '{health}',
        ((provider_meta->'health') - 'alerted_incident' - 'alerted_at' - 'alerted_kind') || ${JSON.stringify(keep)}::jsonb
      )
      WHERE id = ${channelId}::uuid AND provider = 'gmail'
        AND jsonb_typeof(provider_meta->'health') = 'object'
    `)
  },

  async loadMeta(channelId: string): Promise<unknown | null> {
    const rows = await db
      .select({ providerMeta: channels.providerMeta })
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.provider, 'gmail')))
      .limit(1)
    return rows[0] ? rows[0].providerMeta : null
  },

  /**
   * Remove só health.<origem>. null = já não existia (outro sucesso limpou).
   * `authFailedBefore`: só remove se for senha recusada gravada ANTES desse
   * instante (o IMAP logou com a mesma senha depois — ela vale).
   */
  async clearSource(
    channelId: string,
    source: GmailHealthSource,
    authFailedBefore?: string,
  ): Promise<GmailHealthWriteRow | null> {
    const { path, key } = SRC_SQL[source]
    const onlyOld = authFailedBefore
      ? sql`AND c.provider_meta->'health'->${key}->>'verdict' = 'auth_failed'
          AND c.provider_meta->'health'->${key}->>'last_at' < ${authFailedBefore}::text`
      : sql``
    const res = await db.execute(sql`
      UPDATE channels AS c
      SET provider_meta = c.provider_meta #- ${path}
      FROM (SELECT id, provider_meta FROM channels WHERE id = ${channelId}::uuid FOR UPDATE) AS prev
      WHERE c.id = prev.id AND c.provider = 'gmail'
        AND c.provider_meta->'health'->${key} IS NOT NULL
        ${onlyOld}
      RETURNING c.account_id, c.name, c.status, prev.provider_meta AS before, c.provider_meta AS after
    `)
    return toWriteRow(res.rows)
  },

  /** Fecha incidente avisado (reserva do "voltou"). Deixa só o alerted_at pro anti-flap. */
  async reserveRecovery(channelId: string): Promise<boolean> {
    const res = await db.execute(sql`
      UPDATE channels
      SET provider_meta = jsonb_set(
        provider_meta,
        '{health}',
        CASE WHEN jsonb_typeof(provider_meta->'health'->'alerted_at') = 'string'
          THEN jsonb_build_object('alerted_at', provider_meta->'health'->'alerted_at')
          ELSE '{}'::jsonb END
      )
      WHERE id = ${channelId}::uuid AND provider = 'gmail'
        AND jsonb_typeof(provider_meta->'health') = 'object'
        AND provider_meta->'health'->'imap' IS NULL
        AND provider_meta->'health'->'smtp' IS NULL
        AND provider_meta->'health'->>'alerted_incident' = 'true'
      RETURNING id
    `)
    return res.rows.length > 0
  },

  /** Fecha incidente NÃO avisado: some com o health (mantém se houve aviso há < 6 h). */
  async cleanupClosedIncident(channelId: string, cutoffIso: string): Promise<void> {
    await db.execute(sql`
      UPDATE channels
      SET provider_meta = provider_meta - 'health'
      WHERE id = ${channelId}::uuid AND provider = 'gmail'
        AND provider_meta->'health' IS NOT NULL
        AND provider_meta->'health'->'imap' IS NULL
        AND provider_meta->'health'->'smtp' IS NULL
        AND coalesce(provider_meta->'health'->>'alerted_incident', 'false') <> 'true'
        AND NOT (
          jsonb_typeof(provider_meta->'health'->'alerted_at') = 'string'
          AND provider_meta->'health'->>'alerted_at' > ${cutoffIso}::text
        )
    `)
  },

  async accountName(accountId: string): Promise<string | null> {
    const rows = await db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, accountId))
      .limit(1)
    return rows[0]?.name ?? null
  },
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function publishStatus(channelId: string, row: GmailHealthWriteRow): Promise<void> {
  await publishEvent(row.accountId, { type: 'channel_status', channelId, name: row.name, status: row.status })
}

// ------------------------------------------------------------
// API
// ------------------------------------------------------------

/** Uma falha de leitura (imap) ou envio (smtp). Avisa owner/admin 1 vez por incidente. */
export async function recordGmailFailure(channelId: string, source: GmailHealthSource, err: unknown): Promise<void> {
  if (!isSource(source)) return
  try {
    const { verdict, reason } = classifyGmailError(err)
    const now = Date.now()
    const nowIso = new Date(now).toISOString()
    const row = await gmailHealthDb.applyFailure(channelId, source, verdict, reason, nowIso)
    if (!row) return
    const changed = problemChanged(row.before, row.after, now)
    if (changed) await publishStatus(channelId, row)

    const decision = decideIncidentAlert(row.after, now)
    if (!decision.alert) {
      if (changed && decision.why === 'anti_flap') {
        console.warn('[gmail-health] canal %s ("%s") com falha de novo em menos de 6 h — sem novo aviso', channelId, row.name)
      }
      return
    }
    const { problem } = decision
    const marks = rawHealth(row.after) ?? {}
    if (!(await gmailHealthDb.reserveIncidentAlert(channelId, problem.source, problem.kind, nowIso))) return

    const address = addressOf(row.after)
    const text = incidentAlertText(
      { channelName: row.name, address, problem, health: gmailHealthOf(row.after) ?? {} },
      now,
    )
    try {
      const n = await notifyChannelAdmins(row.accountId, text.title, text.body)
      console.warn(
        '[gmail-health] canal %s ("%s"): %s em %s — %d admin(s) avisado(s)%s',
        channelId,
        row.name,
        problem.kind,
        problem.source,
        n,
        decision.escalation ? ' (escalada)' : '',
      )
    } catch (notifyErr) {
      await gmailHealthDb
        .releaseIncidentAlert(channelId, {
          alerted_incident: marks.alerted_incident,
          alerted_at: marks.alerted_at,
          alerted_kind: marks.alerted_kind,
        })
        .catch((e) => console.error('[gmail-health] devolver reserva do aviso falhou canal=%s: %s', channelId, errText(e)))
      throw notifyErr
    }

    if (problem.kind === 'auth_failed') {
      const accountName = await gmailHealthDb.accountName(row.accountId).catch(() => null)
      await alertPlatform(
        `🔴 *Gmail com senha de app recusada*\nConta: ${accountName ?? '?'} (${row.accountId.slice(0, 8)}…)\nCanal: ${row.name}\nEndereço: ${address ?? '?'}\nE-mails não entram e os envios por ele pararam. O CRM avisou os admins da conta.`,
        'gmail-health',
      )
    }
  } catch (err) {
    console.error('[gmail-health] registrar falha canal=%s origem=%s: %s', channelId, source, errText(err))
  }
}

/**
 * Envio pelo Gmail falhou (send-message / disparo). Só senha recusada vira
 * saúde do canal: endereço inválido ou caixa cheia do destinatário são do
 * destinatário, não do canal.
 */
export async function recordGmailSendFailure(
  channelId: string,
  err: unknown,
  /** provider_meta do canal como estava quando o envio carregou a senha. */
  channelMetaAtSend?: unknown,
): Promise<void> {
  try {
    if (classifyGmailError(err).verdict !== 'auth_failed') return
    // Envio (ou disparo longo) que carregou a senha ANTES de alguém trocá-la:
    // a recusa é da senha velha (mesma trava do poll).
    if (channelMetaAtSend !== undefined) {
      const changedNow = passwordChangedAtOf(await gmailHealthDb.loadMeta(channelId))
      if (changedNow !== null && changedNow !== passwordChangedAtOf(channelMetaAtSend)) return
    }
    await recordGmailFailure(channelId, 'smtp', err)
  } catch (e) {
    console.error('[gmail-health] registrar falha de envio canal=%s: %s', channelId, errText(e))
  }
}

function passwordChangedAtOf(providerMeta: unknown): number | null {
  const v = providerMeta && typeof providerMeta === 'object' ? (providerMeta as Record<string, unknown>).gmailPasswordChangedAt : null
  const ms = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(ms) ? ms : null
}

/**
 * O poll logou no IMAP. Fecha a falha de leitura e, se houver "senha recusada"
 * no ENVIO gravada antes deste login, fecha também: é a mesma senha de app, e
 * ela acabou de ser aceita. Sem isso, um canal que só envia pela régua ficaria
 * travado pra sempre (a régua não tenta Gmail bloqueado).
 */
export async function recordGmailImapLoginOk(channelId: string, loginStartedAtMs: number): Promise<void> {
  await recordGmailOk(channelId, 'imap')
  await recordGmailOk(channelId, 'smtp', { authFailedBefore: new Date(loginStartedAtMs).toISOString() })
}

/** A origem funcionou. Barato no caminho feliz: só lê; escreve se havia falha gravada. */
export async function recordGmailOk(
  channelId: string,
  source: GmailHealthSource,
  opts: { authFailedBefore?: string } = {},
): Promise<void> {
  if (!isSource(source)) return
  try {
    const current = await gmailHealthDb.loadMeta(channelId)
    if (!current || !hasSourceEntry(current, source)) return
    const row = await gmailHealthDb.clearSource(channelId, source, opts.authFailedBefore)
    if (!row) return
    const now = Date.now()
    if (problemChanged(row.before, row.after, now)) await publishStatus(channelId, row)

    const h = rawHealth(row.after)
    if (!h) return
    // A outra origem segue falhando: o incidente continua.
    if (h.imap != null || h.smtp != null) return

    if (h.alerted_incident === true) {
      if (!(await gmailHealthDb.reserveRecovery(channelId))) return
      const text = recoveryAlertText(row.name, addressOf(row.after))
      try {
        await notifyChannelAdmins(row.accountId, text.title, text.body)
        console.log('[gmail-health] canal %s ("%s") voltou a funcionar — admins avisados', channelId, row.name)
      } catch (e) {
        console.error('[gmail-health] aviso de "voltou" falhou canal=%s: %s', channelId, errText(e))
      }
      return
    }
    await gmailHealthDb.cleanupClosedIncident(channelId, new Date(now - GMAIL_REALERT_COOLDOWN_MS).toISOString())
  } catch (err) {
    console.error('[gmail-health] registrar sucesso canal=%s origem=%s: %s', channelId, source, errText(err))
  }
}
