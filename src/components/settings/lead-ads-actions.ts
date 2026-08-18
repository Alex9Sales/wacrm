'use server'

// ============================================================
// Server actions das fontes de Anúncios de Lead (lead_ad_sources).
// Tudo escopado na conta. Leitura p/ qualquer membro; escrita exige admin.
// O token é criptografado antes de gravar e NUNCA volta pro cliente.
// ============================================================

import { randomBytes } from 'node:crypto'

import { and, asc, desc, eq } from 'drizzle-orm'

import { db, leadAdSources, pipelines } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { buildTikTokAuthUrl } from '@/lib/leads/providers/tiktok-oauth'
import { buildLinkedInAuthUrl } from '@/lib/leads/providers/linkedin-oauth'

export type LeadProvider = 'tiktok' | 'meta' | 'linkedin'

/** Linha segura (sem o token) exibida na UI. */
export interface LeadSourceRow {
  id: string
  provider: LeadProvider
  name: string
  status: string
  external_account_id: string | null
  form_id: string | null
  verify_token: string | null
  pipeline_id: string | null
  deliver_to_ai: boolean
  enabled: boolean
  has_app_secret: boolean
  created_at: string | null
}

export interface LeadSourceInput {
  provider: LeadProvider
  name: string
  /** page_id (Meta) / advertiser_id (TikTok) / organization id (LinkedIn). */
  externalAccountId: string
  accessToken: string
  formId?: string | null
  /** só Meta; auto-gera se vazio. */
  verifyToken?: string | null
  appSecret?: string | null
  pipelineId?: string | null
  deliverToAi: boolean
  enabled: boolean
}

const SAFE = {
  id: leadAdSources.id,
  provider: leadAdSources.provider,
  name: leadAdSources.name,
  status: leadAdSources.status,
  external_account_id: leadAdSources.externalAccountId,
  form_id: leadAdSources.formId,
  verify_token: leadAdSources.verifyToken,
  pipeline_id: leadAdSources.pipelineId,
  deliver_to_ai: leadAdSources.deliverToAi,
  enabled: leadAdSources.enabled,
  provider_meta: leadAdSources.providerMeta,
  created_at: leadAdSources.createdAt,
}

function toRow(r: Record<string, unknown>): LeadSourceRow {
  const meta = (r.provider_meta ?? {}) as Record<string, unknown>
  return {
    id: r.id as string,
    provider: r.provider as LeadProvider,
    name: r.name as string,
    status: r.status as string,
    external_account_id: (r.external_account_id as string | null) ?? null,
    form_id: (r.form_id as string | null) ?? null,
    verify_token: (r.verify_token as string | null) ?? null,
    pipeline_id: (r.pipeline_id as string | null) ?? null,
    deliver_to_ai: !!r.deliver_to_ai,
    enabled: !!r.enabled,
    has_app_secret: typeof meta.appSecret === 'string' && !!meta.appSecret,
    created_at: (r.created_at as string | null) ?? null,
  }
}

/** Lista as fontes da conta (mais novas primeiro). */
export async function listLeadSources(): Promise<LeadSourceRow[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select(SAFE)
    .from(leadAdSources)
    .where(eq(leadAdSources.accountId, ctx.accountId))
    .orderBy(desc(leadAdSources.createdAt))
  return rows.map((r) => toRow(r as Record<string, unknown>))
}

/** Inicia o OAuth 1-clique do TikTok — devolve a URL de autorização.
 *  Lança uma mensagem amigável se o app do TikTok ainda não estiver
 *  configurado (em análise). */
export async function getTikTokConnectUrl(): Promise<string> {
  const ctx = await requireRole('admin')
  return buildTikTokAuthUrl(ctx.accountId)
}

/** Inicia o OAuth 1-clique do LinkedIn — devolve a URL de autorização.
 *  Lança uma mensagem amigável se o Lead Sync ainda não estiver liberado
 *  (em análise). */
export async function getLinkedInConnectUrl(): Promise<string> {
  const ctx = await requireRole('admin')
  return buildLinkedInAuthUrl(ctx.accountId)
}

/** Funis da conta p/ o seletor de destino. */
export async function listPipelinesForSelect(): Promise<
  { id: string; name: string }[]
> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({ id: pipelines.id, name: pipelines.name })
    .from(pipelines)
    .where(eq(pipelines.accountId, ctx.accountId))
    .orderBy(asc(pipelines.createdAt))
  return rows
}

function validate(input: LeadSourceInput): void {
  if (
    input.provider !== 'tiktok' &&
    input.provider !== 'meta' &&
    input.provider !== 'linkedin'
  ) {
    throw new Error('Provedor inválido.')
  }
  if (!input.name.trim()) throw new Error('Dê um nome à fonte.')
  if (!input.externalAccountId.trim()) {
    throw new Error(
      input.provider === 'meta'
        ? 'Informe o page_id da Página.'
        : input.provider === 'linkedin'
          ? 'Informe o organization id (id numérico da Página de empresa).'
          : 'Informe o advertiser_id da conta de anúncios.',
    )
  }
  if (!input.accessToken.trim()) throw new Error('Cole o token de acesso.')
}

function buildProviderMeta(input: LeadSourceInput): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  if (input.appSecret?.trim()) meta.appSecret = input.appSecret.trim()
  return meta
}

/** Cria uma fonte (token criptografado; verify_token auto no Meta). */
export async function createLeadSource(
  input: LeadSourceInput,
): Promise<LeadSourceRow> {
  const ctx = await requireRole('admin')
  validate(input)
  const verifyToken =
    input.provider === 'meta'
      ? input.verifyToken?.trim() || randomBytes(12).toString('hex')
      : input.verifyToken?.trim() || null

  const row = firstOrNull(
    await db
      .insert(leadAdSources)
      .values({
        accountId: ctx.accountId,
        provider: input.provider,
        name: input.name.trim(),
        status: 'connected',
        externalAccountId: input.externalAccountId.trim(),
        formId: input.formId?.trim() || null,
        accessToken: encrypt(input.accessToken.trim()),
        verifyToken,
        pipelineId: input.pipelineId?.trim() || null,
        deliverToAi: input.deliverToAi,
        enabled: input.enabled,
        providerMeta: buildProviderMeta(input),
      })
      .returning(SAFE),
  )
  if (!row) throw new Error('Falha ao criar a fonte.')
  return toRow(row as Record<string, unknown>)
}

/** Atualiza uma fonte. Token só é re-gravado se um novo vier (senão mantém). */
export async function updateLeadSource(
  id: string,
  input: LeadSourceInput,
): Promise<void> {
  const ctx = await requireRole('admin')
  validate(input)
  const set: Record<string, unknown> = {
    name: input.name.trim(),
    externalAccountId: input.externalAccountId.trim(),
    formId: input.formId?.trim() || null,
    pipelineId: input.pipelineId?.trim() || null,
    deliverToAi: input.deliverToAi,
    enabled: input.enabled,
    providerMeta: buildProviderMeta(input),
    updatedAt: new Date().toISOString(),
  }
  if (input.accessToken.trim()) {
    set.accessToken = encrypt(input.accessToken.trim())
  }
  if (input.provider === 'meta' && input.verifyToken?.trim()) {
    set.verifyToken = input.verifyToken.trim()
  }
  await db
    .update(leadAdSources)
    .set(set)
    .where(
      and(eq(leadAdSources.id, id), eq(leadAdSources.accountId, ctx.accountId)),
    )
}

/** Liga/desliga uma fonte. */
export async function toggleLeadSource(
  id: string,
  enabled: boolean,
): Promise<void> {
  const ctx = await requireRole('admin')
  await db
    .update(leadAdSources)
    .set({ enabled, updatedAt: new Date().toISOString() })
    .where(
      and(eq(leadAdSources.id, id), eq(leadAdSources.accountId, ctx.accountId)),
    )
}

/** Remove uma fonte. */
export async function deleteLeadSource(id: string): Promise<void> {
  const ctx = await requireRole('admin')
  await db
    .delete(leadAdSources)
    .where(
      and(eq(leadAdSources.id, id), eq(leadAdSources.accountId, ctx.accountId)),
    )
}
