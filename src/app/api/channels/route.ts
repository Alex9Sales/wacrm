// ============================================================
// Channels collection route (Phase 4, wave 4A).
//
//   GET  /api/channels  — list the account's channels (SAFE fields only;
//                         never credentials or webhook_secret).
//   POST /api/channels  — create a channel (provider-specific config →
//                         encrypted credentials + provider_meta).
//
// Both admin-gated via requireRole('admin'). createChannel() owns the
// credential encryption + webhook_secret generation.
// ============================================================

import { randomBytes } from 'node:crypto'

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db, channels } from '@/db'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { createChannel, type CreateChannelInput } from '@/lib/channels/channels'
import { EMAIL_HOSTED_DOMAIN } from '@/lib/channels/providers/email-domains'
import type { ProviderId } from '@/lib/channels/provider'

// Managed (Fluxia-hosted) infra for the non-official providers. When these
// env vars are set, the operator does NOT type a URL/key/session — they just
// name the channel and the platform fills the connection from here and
// auto-generates a unique session/instance name. Falls back to any explicit
// config the caller passed (advanced / self-hosted use).
// WAHA default = a engine COM VOZ (waha-calls, :3999). Antes o default vinha
// só da env; se ela derivasse pro :3010 (só-mensagens), todo canal novo nascia
// SEM voz (furo de onboarding do Felipe). Agora o :3999 é o piso, e a env só
// sobrepõe se apontar pra outro lugar de propósito. Ver [[crmfluxia-waha-voice-engine-3999]].
const WAHA_VOICE_BASE_URL = 'http://72.60.137.234:3999'

// E-mail HOSPEDADO (multi-tenant): o cliente só escolhe um "apelido" e a
// plataforma monta `apelido@<EMAIL_HOSTED_DOMAIN>` no domínio verificado da
// Fluxia — sem DNS, sem token (recebe pelo catch-all do Cloudflare Worker,
// valida pela env compartilhada EMAIL_INBOUND_SECRET, envia pela RESEND_API_KEY
// global). Ver [[crmfluxia-email-canal]]. `EMAIL_HOSTED_DOMAIN` mora em
// email-domains.ts (compartilhado com o fluxo de domínio próprio).
const MANAGED = {
  waha: {
    baseUrl: process.env.WAHA_BASE_URL || WAHA_VOICE_BASE_URL,
    apiKey: process.env.WAHA_API_KEY,
  },
  evolution: {
    baseUrl: process.env.EVOLUTION_BASE_URL,
    apiKey: process.env.EVOLUTION_API_KEY,
  },
  evogo: { baseUrl: process.env.EVOGO_BASE_URL, apiKey: process.env.EVOGO_TOKEN },
} as const

/** Unique session/instance name for a managed connection on a shared server. */
function managedSessionName(): string {
  return `crmfluxia-${randomBytes(5).toString('hex')}`
}

const PROVIDERS: ReadonlySet<ProviderId> = new Set([
  'meta',
  'instagram',
  'messenger',
  'email',
  'gmail',
  'waha',
  'evolution',
  'evogo',
])

/**
 * The SAFE subset of provider_meta we expose on GET. NEVER include
 * anything from `credentials` (tokens/keys) or the webhook_secret. For
 * meta we expose the routing ids; for the non-official providers the
 * base URL + session/instance name.
 */
function safeProviderMeta(
  provider: string,
  meta: Record<string, unknown>,
): Record<string, unknown> {
  // Location pin + Pix key are cross-provider — expose on every channel so
  // Settings can show/edit what's saved.
  const location = meta.location ?? null
  const pix = meta.pix ?? null
  if (provider === 'meta') {
    return {
      phone_number_id: meta.phone_number_id ?? null,
      waba_id: meta.waba_id ?? null,
      location,
      pix,
    }
  }
  if (provider === 'instagram') {
    return { ig_id: meta.ig_id ?? null, graphBase: meta.graphBase ?? null, location, pix }
  }
  if (provider === 'messenger') {
    return { page_id: meta.page_id ?? null, graphBase: meta.graphBase ?? null, location, pix }
  }
  if (provider === 'email') {
    // Expõe endereço + From + (branded) o modo/domínio pra UI mostrar o botão
    // "Configurar domínio". resendApiKey/inboundSecret/ingestAddress/domainId
    // ficam no `credentials`/meta e NÃO são expostos.
    return {
      address: meta.address ?? null,
      from: meta.from ?? null,
      mode: meta.mode ?? null,
      domain_name: meta.domainName ?? null,
      domain_status: meta.domainStatus ?? null,
      location,
      pix,
    }
  }
  if (provider === 'gmail') {
    // Só o endereço Gmail. appPassword fica em `credentials` (nunca exposto).
    return { address: meta.address ?? null, location, pix }
  }
  // waha / evolution / evogo: baseUrl + the session or instance name.
  return {
    baseUrl: meta.baseUrl ?? null,
    session: meta.session ?? undefined,
    instance: meta.instance ?? undefined,
    location,
    pix,
  }
}

/**
 * GET /api/channels
 *
 * Response: { channels: [{ id, provider, name, status, phone_number,
 *   provider_meta: <safe subset>, created_at }] }
 */
export async function GET() {
  try {
    const ctx = await requireRole('admin')
    // Select only the SAFE columns directly — never `credentials` or
    // `webhook_secret`. (ChannelCtx omits status/created_at, and decrypting
    // every row just to list them is wasteful, so we read the row shape.)
    const rows = await db
      .select({
        id: channels.id,
        provider: channels.provider,
        name: channels.name,
        status: channels.status,
        phoneNumber: channels.phoneNumber,
        providerMeta: channels.providerMeta,
        createdAt: channels.createdAt,
      })
      .from(channels)
      .where(eq(channels.accountId, ctx.accountId))

    return NextResponse.json({
      channels: rows.map((ch) => ({
        id: ch.id,
        provider: ch.provider,
        name: ch.name,
        status: ch.status,
        phone_number: ch.phoneNumber,
        provider_meta: safeProviderMeta(
          ch.provider,
          (ch.providerMeta ?? {}) as Record<string, unknown>,
        ),
        created_at: ch.createdAt ?? null,
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * Build the CreateChannelInput (credentials + providerMeta) for a given
 * provider from the request `config`. Throws a plain Error with a
 * user-facing message on a missing required field — the POST handler maps
 * that to a 400.
 */
function buildCreateInput(
  provider: ProviderId,
  name: string,
  config: Record<string, unknown>,
): CreateChannelInput {
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v : null

  switch (provider) {
    case 'meta': {
      const phone_number_id = str(config.phone_number_id)
      const waba_id = str(config.waba_id)
      const access_token = str(config.access_token)
      const verify_token = str(config.verify_token)
      const missing = [
        !phone_number_id && 'phone_number_id',
        !waba_id && 'waba_id',
        !access_token && 'access_token',
        !verify_token && 'verify_token',
      ].filter(Boolean)
      if (missing.length) {
        throw new BadRequestError(
          `meta channel requires: ${missing.join(', ')}`,
        )
      }
      return {
        provider,
        name,
        credentials: { accessToken: access_token, verifyToken: verify_token },
        providerMeta: { phone_number_id, waba_id },
      }
    }
    case 'instagram': {
      // Conexão MANUAL (piloto): id da conta IG + token. graph_base opcional
      // (use graph.instagram.com/v21.0 pro login do Instagram).
      const ig_id = str(config.ig_id)
      const access_token = str(config.access_token)
      const graph_base = str(config.graph_base)
      // Token de verificação do webhook (o mesmo usado ao inscrever na Meta).
      // Auto-gera um se não vier — o GET /api/webhooks/instagram casa por ele.
      const verify_token = str(config.verify_token) || randomBytes(12).toString('hex')
      const missing = [!ig_id && 'ig_id', !access_token && 'access_token'].filter(
        Boolean,
      )
      if (missing.length) {
        throw new BadRequestError(
          `instagram channel requires: ${missing.join(', ')}`,
        )
      }
      return {
        provider,
        name,
        // Token-based: já vem conectado (não pareia por QR).
        status: 'connected',
        credentials: { accessToken: access_token, verifyToken: verify_token },
        providerMeta: graph_base
          ? { ig_id, graphBase: graph_base }
          : { ig_id },
      }
    }
    case 'messenger': {
      // Conexão MANUAL: id da Página do Facebook + token da Página. Roda em
      // graph.facebook.com (default).
      const page_id = str(config.page_id)
      const access_token = str(config.access_token)
      const graph_base = str(config.graph_base)
      // Auto-gera um se não vier — o GET /api/webhooks/messenger casa por ele.
      const verify_token = str(config.verify_token) || randomBytes(12).toString('hex')
      const missing = [!page_id && 'page_id', !access_token && 'access_token'].filter(
        Boolean,
      )
      if (missing.length) {
        throw new BadRequestError(
          `messenger channel requires: ${missing.join(', ')}`,
        )
      }
      return {
        provider,
        name,
        // Token-based: já vem conectado (não pareia por QR).
        status: 'connected',
        credentials: { accessToken: access_token, verifyToken: verify_token },
        providerMeta: graph_base
          ? { page_id, graphBase: graph_base }
          : { page_id },
      }
    }
    case 'email': {
      const from_name = str(config.from_name)
      const handleRaw = str(config.handle)
      const addressRaw = str(config.address)

      // HOSPEDADO (padrão): cliente só dá um apelido → `apelido@<domínio>`.
      // Tolerante: se digitar o e-mail inteiro, pega só a parte antes do @.
      // Sem segredo/chave por canal (usa a env compartilhada + Resend global).
      if (handleRaw && !addressRaw) {
        const handle = handleRaw.split('@')[0].trim().toLowerCase()
        if (!/^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/.test(handle)) {
          throw new BadRequestError(
            'Escolha um endereço válido (letras minúsculas, números, ponto, hífen ou "_"). Ex.: atendimento, suporte.vendas',
          )
        }
        const address = `${handle}@${EMAIL_HOSTED_DOMAIN}`
        const credentials: Record<string, unknown> = {}
        if (from_name) credentials.fromName = from_name
        return {
          provider,
          name,
          status: 'connected',
          credentials,
          providerMeta: { address, from: address },
        }
      }

      // AVANÇADO / BYO: endereço completo + (opcional) From, chave Resend e
      // segredo de inbound próprios. Nasce 'connected' (não pareia por QR).
      const address = addressRaw ? addressRaw.trim().toLowerCase() : null
      if (!address || !address.includes('@')) {
        throw new BadRequestError(
          'Informe um apelido de e-mail (ex.: atendimento) ou o endereço completo no modo avançado.',
        )
      }
      const from = str(config.from)
      const resend_api_key = str(config.resend_api_key)
      // SMTP genérico (BYO — qualquer provedor: Hostinger, HostGator, etc.).
      const smtp_host = str(config.smtp_host)
      const smtp_user = str(config.smtp_user)
      const smtp_password = str(config.smtp_password)
      const smtp_port = str(config.smtp_port)
      // Auto-gera o segredo do webhook se não vier.
      const inbound_secret = str(config.inbound_secret) || randomBytes(16).toString('hex')
      const credentials: Record<string, unknown> = { inboundSecret: inbound_secret }
      if (resend_api_key) credentials.resendApiKey = resend_api_key
      if (smtp_host && smtp_user && smtp_password) {
        credentials.smtpHost = smtp_host
        credentials.smtpUser = smtp_user
        credentials.smtpPassword = smtp_password
        credentials.smtpPort = smtp_port ? Number(smtp_port) : 587
      }
      if (from_name) credentials.fromName = from_name
      const providerMeta: Record<string, unknown> = { address }
      if (from) providerMeta.from = from
      return { provider, name, status: 'connected', credentials, providerMeta }
    }
    case 'gmail': {
      // Gmail dedicado: e-mail + senha de app (2FA). Envia por SMTP, recebe por
      // IMAP (worker). Nasce 'connected' (a rota valida o login antes).
      const addressRaw = str(config.address)
      const address = addressRaw ? addressRaw.trim().toLowerCase() : null
      if (!address || !address.includes('@')) {
        throw new BadRequestError(
          'Informe o endereço do Gmail (ex.: seunegocio@gmail.com).',
        )
      }
      const app_password = str(config.app_password)
      if (!app_password) {
        throw new BadRequestError('Cole a senha de app do Google (16 letras).')
      }
      const from_name = str(config.from_name)
      const credentials: Record<string, unknown> = {
        address,
        appPassword: app_password.replace(/\s+/g, ''),
      }
      if (from_name) credentials.fromName = from_name
      return {
        provider,
        name,
        status: 'connected',
        credentials,
        providerMeta: { address },
      }
    }
    case 'waha': {
      // Managed by default: fall back to the platform WAHA server + auto
      // session. Advanced callers may still pass their own base_url/api_key.
      const base_url = str(config.base_url) || MANAGED.waha.baseUrl || ''
      const api_key = str(config.api_key) || MANAGED.waha.apiKey || ''
      const session = str(config.session) || managedSessionName()
      if (!base_url || !api_key) {
        throw new BadRequestError(
          'Canal WAHA indisponível: a conexão gerenciada da Fluxia não está configurada.',
        )
      }
      return {
        provider,
        name,
        credentials: { apiKey: api_key },
        providerMeta: { baseUrl: base_url, session },
      }
    }
    case 'evolution': {
      const base_url = str(config.base_url) || MANAGED.evolution.baseUrl || ''
      const api_key = str(config.api_key) || MANAGED.evolution.apiKey || ''
      const instance = str(config.instance) || managedSessionName()
      if (!base_url || !api_key) {
        throw new BadRequestError(
          'Canal Evolution indisponível: a conexão gerenciada da Fluxia não está configurada.',
        )
      }
      return {
        provider,
        name,
        credentials: { apiKey: api_key },
        providerMeta: { baseUrl: base_url, instance },
      }
    }
    case 'evogo': {
      const base_url = str(config.base_url) || MANAGED.evogo.baseUrl || ''
      const token = str(config.token) || MANAGED.evogo.apiKey || ''
      if (!base_url || !token) {
        throw new BadRequestError(
          'Canal EvoGo indisponível: a conexão gerenciada da Fluxia não está configurada.',
        )
      }
      return {
        provider,
        name,
        credentials: { token },
        providerMeta: { baseUrl: base_url },
      }
    }
    default:
      throw new BadRequestError(`Unknown provider "${provider}"`)
  }
}

/** A 400-worthy validation failure (thrown by buildCreateInput). */
class BadRequestError extends Error {}

/** Detect a UNIQUE(account_id, name) violation from the DB error. */
function isDuplicateNameError(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; message?: string }
  return (
    e?.code === '23505' &&
    (e?.constraint === 'channels_account_id_name_key' ||
      (typeof e?.message === 'string' &&
        e.message.includes('channels_account_id_name_key')))
  )
}

/** Detect a duplicate email-address violation (unique idx channels_email_addr). */
function isDuplicateEmailAddressError(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; message?: string }
  return (
    e?.code === '23505' &&
    (e?.constraint === 'channels_email_addr' ||
      (typeof e?.message === 'string' &&
        e.message.includes('channels_email_addr')))
  )
}

/**
 * POST /api/channels
 *
 * Body: { provider, name, config: {...provider-specific} }.
 * Returns { id }. 400 on missing fields, 409 on a duplicate channel name
 * within the account.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    const {
      provider,
      name,
      config = {},
    } = (body ?? {}) as {
      provider?: string
      name?: string
      config?: Record<string, unknown>
    }

    if (!provider || !PROVIDERS.has(provider as ProviderId)) {
      return NextResponse.json(
        { error: 'provider must be one of meta, waha, evolution, evogo' },
        { status: 400 },
      )
    }
    if (typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }

    let input: CreateChannelInput
    try {
      input = buildCreateInput(provider as ProviderId, name.trim(), config)
    } catch (err) {
      if (err instanceof BadRequestError) {
        return NextResponse.json({ error: err.message }, { status: 400 })
      }
      throw err
    }

    // Gmail: valida o login SMTP antes de criar — assim uma senha de app errada
    // falha na hora, com mensagem clara, em vez de só no 1º envio.
    if (provider === 'gmail') {
      const creds = input.credentials as { address?: string; appPassword?: string }
      try {
        const { verifyGmailLogin } = await import('@/lib/channels/providers/gmail')
        await verifyGmailLogin(String(creds.address ?? ''), String(creds.appPassword ?? ''))
      } catch {
        return NextResponse.json(
          {
            error:
              'Não consegui conectar ao Gmail. Confira o e-mail e a senha de app (precisa da verificação em 2 etapas ativada).',
          },
          { status: 400 },
        )
      }
    }

    // E-mail BYO-SMTP: valida o login SMTP antes de criar.
    if (provider === 'email' && typeof input.credentials.smtpHost === 'string') {
      const c = input.credentials as {
        smtpHost?: string
        smtpPort?: number
        smtpUser?: string
        smtpPassword?: string
      }
      try {
        const { verifySmtpLogin } = await import('@/lib/channels/providers/email')
        await verifySmtpLogin(
          String(c.smtpHost ?? ''),
          Number(c.smtpPort) || 587,
          String(c.smtpUser ?? ''),
          String(c.smtpPassword ?? ''),
        )
      } catch {
        return NextResponse.json(
          {
            error:
              'Não consegui conectar ao servidor SMTP. Confira host, porta, usuário e senha.',
          },
          { status: 400 },
        )
      }
    }

    let channel
    try {
      channel = await createChannel(ctx.accountId, input)
    } catch (err) {
      if (isDuplicateEmailAddressError(err)) {
        return NextResponse.json(
          { error: 'Esse endereço de e-mail já está em uso. Escolha outro apelido.' },
          { status: 409 },
        )
      }
      if (isDuplicateNameError(err)) {
        return NextResponse.json(
          { error: `A channel named "${name.trim()}" already exists.` },
          { status: 409 },
        )
      }
      throw err
    }

    // BYO ("meu provedor"): o canal de e-mail avançado tem inboundSecret próprio.
    // Devolvemos o webhook de entrada + o segredo pra o cliente apontar o inbound
    // do provedor dele (a UI mostra numa tela; a Fluxia é só o inbox).
    const inboundSecret =
      provider === 'email' && typeof input.credentials.inboundSecret === 'string'
        ? input.credentials.inboundSecret
        : null
    const address =
      provider === 'email'
        ? (input.providerMeta?.address as string | undefined) ?? null
        : null

    return NextResponse.json(
      {
        id: channel.id,
        ...(inboundSecret
          ? {
              inbound: {
                webhook_url: 'https://crm.salestecnologia.com.br/api/webhooks/email',
                header: 'x-email-token',
                secret: inboundSecret,
                address,
              },
            }
          : {}),
      },
      { status: 201 },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
