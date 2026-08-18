// ============================================================
// Fontes de Anúncios de Lead (lead_ad_sources) — carregamento + roteamento.
//
// O webhook chega SEM saber de qual conta é: descobrimos pela chave de
// roteamento (page_id no Meta / advertiser_id no TikTok) + form_id opcional.
// O token fica criptografado no banco (mesma cripto dos canais) e só é
// decifrado aqui, na hora de usar.
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, leadAdSources } from '@/db'
import { decrypt } from '@/lib/whatsapp/encryption'

export type LeadProvider = 'tiktok' | 'meta' | 'linkedin'

export interface LoadedLeadSource {
  id: string
  accountId: string
  provider: LeadProvider
  name: string
  externalAccountId: string | null
  formId: string | null
  /** Token JÁ decifrado — nunca logar/serializar. */
  accessToken: string
  verifyToken: string | null
  pipelineId: string | null
  stageId: string | null
  deliverToAi: boolean
  enabled: boolean
  providerMeta: Record<string, unknown>
}

const ROW = {
  id: leadAdSources.id,
  accountId: leadAdSources.accountId,
  provider: leadAdSources.provider,
  name: leadAdSources.name,
  externalAccountId: leadAdSources.externalAccountId,
  formId: leadAdSources.formId,
  accessToken: leadAdSources.accessToken,
  verifyToken: leadAdSources.verifyToken,
  pipelineId: leadAdSources.pipelineId,
  stageId: leadAdSources.stageId,
  deliverToAi: leadAdSources.deliverToAi,
  enabled: leadAdSources.enabled,
  providerMeta: leadAdSources.providerMeta,
}

type RawRow = {
  id: string
  accountId: string
  provider: string
  name: string
  externalAccountId: string | null
  formId: string | null
  accessToken: string
  verifyToken: string | null
  pipelineId: string | null
  stageId: string | null
  deliverToAi: boolean
  enabled: boolean
  providerMeta: unknown
}

/** Decifra o token e normaliza a linha. Retorna null se o token não abrir. */
function mapRow(row: RawRow): LoadedLeadSource | null {
  let accessToken: string
  try {
    accessToken = decrypt(row.accessToken)
  } catch (err) {
    console.error('[lead-sources] token decrypt failed for source', row.id, err)
    return null
  }
  return {
    id: row.id,
    accountId: row.accountId,
    provider: row.provider as LeadProvider,
    name: row.name,
    externalAccountId: row.externalAccountId,
    formId: row.formId,
    accessToken,
    verifyToken: row.verifyToken,
    pipelineId: row.pipelineId,
    stageId: row.stageId,
    deliverToAi: row.deliverToAi,
    enabled: row.enabled,
    providerMeta: (row.providerMeta ?? {}) as Record<string, unknown>,
  }
}

/**
 * Acha a fonte que atende um evento de webhook. Escolhe a melhor entre as
 * habilitadas do mesmo (provider, externalAccountId):
 *   1) a que amarra exatamente no form_id do evento;
 *   2) a "page-level" (form_id null → serve qualquer formulário);
 *   3) qualquer outra habilitada (fallback).
 * Retorna null se nenhuma fonte habilitada bater.
 */
export async function loadLeadSourceForWebhook(
  provider: LeadProvider,
  externalAccountId: string,
  formId?: string | null,
): Promise<LoadedLeadSource | null> {
  const rows = (await db
    .select(ROW)
    .from(leadAdSources)
    .where(
      and(
        eq(leadAdSources.provider, provider),
        eq(leadAdSources.externalAccountId, externalAccountId),
        eq(leadAdSources.enabled, true),
      ),
    )) as RawRow[]

  const sources = rows.map(mapRow).filter((s): s is LoadedLeadSource => !!s)
  if (sources.length === 0) return null

  if (formId) {
    const exact = sources.find((s) => s.formId === formId)
    if (exact) return exact
  }
  const pageLevel = sources.find((s) => !s.formId)
  return pageLevel ?? sources[0]
}

/**
 * Verificação do GET do webhook do Meta: casa o hub.verify_token com uma
 * fonte Meta habilitada. Retorna true se alguma fonte tiver esse verify_token.
 */
export async function metaVerifyTokenMatches(token: string): Promise<boolean> {
  if (!token) return false
  const rows = await db
    .select({ id: leadAdSources.id })
    .from(leadAdSources)
    .where(
      and(
        eq(leadAdSources.provider, 'meta'),
        eq(leadAdSources.verifyToken, token),
      ),
    )
    .limit(1)
  return rows.length > 0
}
