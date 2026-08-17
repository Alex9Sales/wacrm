// ============================================================
// Motor dos Anúncios de Lead: pega um lead JÁ resolvido (nome/telefone/campos)
// + a fonte que o recebeu e joga no CRM via ingestLead (contato + card + tarefa
// + etiquetas). Um lugar só pra Meta e TikTok — só muda o rótulo da origem.
// ============================================================

import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { ingestLead, type IngestLeadResult } from '@/lib/leads/ingest'
import type { LoadedLeadSource } from '@/lib/leads/sources'
import { type FetchedLead, buildLeadNotes } from '@/lib/leads/providers/shared'

const PROVIDER_LABEL: Record<LoadedLeadSource['provider'], string> = {
  tiktok: 'TikTok',
  meta: 'Meta',
}

/** Etiquetas da origem — pra filtrar o lead no funil num piscar de olhos. */
function leadTags(source: LoadedLeadSource, meta: Record<string, string>): string[] {
  const tags = new Set<string>(['lead-anuncio', `lead-${source.provider}`])
  if (meta['Campanha']) tags.add('lead-campanha')
  return [...tags]
}

/** Mensagem de abertura no WhatsApp (quando "entregar pra IA" está ligado). */
function introMessage(source: LoadedLeadSource, lead: FetchedLead): string {
  const custom = source.providerMeta.introMessage
  if (typeof custom === 'string' && custom.trim()) return custom.trim()
  const first = lead.name?.split(/\s+/)[0]
  return `Oi${first ? ' ' + first : ''}! Recebemos o seu contato pelo anúncio. Como posso te ajudar?`
}

/**
 * Ingesta um lead resolvido. Precisa de telefone (o contato é indexado por
 * telefone). Sem telefone → registra e ignora (best-effort, não derruba nada).
 */
export async function ingestFetchedLead(
  source: LoadedLeadSource,
  lead: FetchedLead,
): Promise<IngestLeadResult | null> {
  if (!lead.phone) {
    console.error(
      `[lead-ads] lead sem telefone (fonte ${source.id}/${source.provider}) — ignorado`,
    )
    return null
  }

  const auditUserId = await resolveAuditUserId(source.accountId)
  const label = PROVIDER_LABEL[source.provider]
  const known = [lead.name, lead.phone, lead.email, lead.company]
  const notes = buildLeadNotes(lead.fields, lead.meta, known)

  return ingestLead(source.accountId, auditUserId, {
    rawPhone: lead.phone,
    name: lead.name,
    email: lead.email,
    company: lead.company,
    notes: notes || null,
    tags: leadTags(source, lead.meta),
    pipelineId: source.pipelineId,
    stageId: source.stageId,
    taskSuffix: `lead de anúncio (${label})`,
    fallbackNote: `Lead de anúncio (${label}).`,
    introText: source.deliverToAi ? introMessage(source, lead) : null,
    channelId:
      typeof source.providerMeta.introChannelId === 'string'
        ? source.providerMeta.introChannelId
        : null,
  })
}
