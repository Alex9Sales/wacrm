// ============================================================
// Mapa FluxiaCRM ↔ RD Station CRM — puro (sem banco, sem rede).
//
// Os funis foram espelhados com o MESMO nome e as mesmas etapas nos dois
// lados; o casamento é pelo nome, sem acento e sem caixa ("NOVO LEAD" ≡ "Novo
// lead", "ENVIO DA COF" ≡ "Envio da COF"). Funil daqui sem par lá (ex.: o
// "Funil de vendas" padrão) simplesmente não sincroniza.
// ============================================================

import { usefulOrigin } from '@/lib/leads/lead-facts'

import { rid, type RdDeal, type RdPipeline } from './client'

export const canonName = (s: string | null | undefined): string =>
  (s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

export interface RdStageRef {
  pipelineId: string
  pipelineName: string
  stageId: string
  stageName: string
  /** Ordem da etapa DENTRO do funil do RD (0 = entrada), pelo `order` do RD. */
  position: number
}

export interface LocalFunnel {
  id: string
  name: string
  stages: { id: string; name: string }[]
}

/** Índice das etapas do RD por "funil|etapa" (canônico) e por id da etapa. */
export function indexRdStages(pipelines: RdPipeline[]): {
  byName: Map<string, RdStageRef>
  byStageId: Map<string, RdStageRef>
} {
  const byName = new Map<string, RdStageRef>()
  const byStageId = new Map<string, RdStageRef>()
  for (const p of pipelines) {
    const pipelineId = rid(p)
    if (!pipelineId) continue
    // Posição pelo `order` do RD (a lista nem sempre vem ordenada); sem
    // `order`, vale a ordem da lista. Sort estável: empate mantém a lista.
    const ordered = (p.deal_stages ?? [])
      .map((s, i) => ({ s, i }))
      .sort((a, b) => (a.s.order ?? a.i) - (b.s.order ?? b.i))
    for (const [position, { s }] of ordered.entries()) {
      const stageId = rid(s)
      if (!stageId) continue
      const ref = { pipelineId, pipelineName: p.name ?? '', stageId, stageName: s.name ?? '', position }
      byName.set(`${canonName(p.name)}|${canonName(s.name)}`, ref)
      byStageId.set(stageId, ref)
    }
  }
  return { byName, byStageId }
}

/** Etapa do RD que corresponde a (funil, etapa) daqui. */
export function rdStageFor(
  index: ReturnType<typeof indexRdStages>,
  pipelineName: string,
  stageName: string,
): RdStageRef | null {
  return index.byName.get(`${canonName(pipelineName)}|${canonName(stageName)}`) ?? null
}

/** Funil/etapa daqui que corresponde a uma etapa do RD. */
export function localStageFor(
  funnels: LocalFunnel[],
  rdPipelineName: string,
  rdStageName: string,
): { pipelineId: string; stageId: string; pipelineName: string; stageName: string } | null {
  const f = funnels.find((x) => canonName(x.name) === canonName(rdPipelineName))
  const s = f?.stages.find((x) => canonName(x.name) === canonName(rdStageName))
  return f && s ? { pipelineId: f.id, stageId: s.id, pipelineName: f.name, stageName: s.name } : null
}

export type SyncStatus = 'open' | 'won' | 'lost'

/** Status do negócio no RD (API: `win`; webhook: `status`) → o nosso. */
export function rdStatusOf(d: { win?: boolean | null; status?: string | null }): SyncStatus {
  const s = (d.status ?? '').toLowerCase()
  if (s === 'won') return 'won'
  if (s === 'lost') return 'lost'
  if (s === 'ongoing' || s === 'paused') return 'open'
  if (d.win === true) return 'won'
  if (d.win === false) return 'lost'
  return 'open'
}

/** Status daqui (deals.status) normalizado — qualquer coisa estranha é "aberto". */
export function localStatusOf(status: string | null | undefined): SyncStatus {
  return status === 'won' ? 'won' : status === 'lost' ? 'lost' : 'open'
}

/** Motivo de perda do RD com o mesmo nome; senão "Outros"; senão null. */
export function lostReasonIdFor(
  reasons: { id?: string; _id?: string; name?: string }[],
  reason: string | null | undefined,
): string | null {
  const find = (text: string | null | undefined) => {
    const want = canonName(text)
    return want ? reasons.find((r) => canonName(r.name) === want) : undefined
  }
  // "Não respondeu (5 follow-ups)" (desistência do follow-up) é o "Não
  // respondeu" do RD — o detalhe entre parênteses segue na nota da perda.
  const hit = find(reason) ?? find((reason ?? '').replace(/\s*\([^)]*\)\s*$/, ''))
  const other = reasons.find((r) => canonName(r.name) === 'outros')
  return rid(hit ?? other ?? null)
}

/** Variações de telefone pra busca de contato no RD (com 55, sem 55, com +). */
export function phoneVariants(phone: string | null | undefined): string[] {
  const d = (phone ?? '').replace(/\D/g, '')
  if (d.length < 10) return []
  const national = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d
  return [...new Set([d, `+${d}`, national])]
}

/**
 * O que precisa mudar no RD pra ficar igual ao card daqui. Negócio FECHADO no
 * RD não reabre pela API — aí só registra que divergiu (`blocked`).
 */
export function planRdUpdate(input: {
  want: { stageId: string; status: SyncStatus; lostReasonId: string | null }
  have: { stageId: string | null; status: SyncStatus }
}): { moveTo: string | null; close: 'won' | 'lost' | null; blocked: string | null } {
  const { want, have } = input
  if (have.status !== 'open') {
    const blocked =
      want.status !== have.status || want.stageId !== have.stageId
        ? `negócio já ${have.status === 'won' ? 'GANHO' : 'PERDIDO'} no RD — a API não reabre nem move`
        : null
    return { moveTo: null, close: null, blocked }
  }
  const moveTo = want.stageId !== have.stageId ? want.stageId : null
  const close = want.status === 'open' ? null : want.status
  return { moveTo, close, blocked: null }
}

// ------------------------------------------------------------
// Negócio NOVO no RD que nasce de um card copiado entre funis (01/10).
// ------------------------------------------------------------

/**
 * Campos personalizados que IDENTIFICAM o registro em outro sistema (o ERP da
 * franqueadora grava o id e a data de criação dele no negócio de pré-vendas).
 * Copiados para o negócio do comercial, o outro sistema enxergaria DOIS
 * registros com o mesmo id. Comparados pela chave canônica do rótulo E do slug
 * (sem acento, sem caixa, separador vira "_").
 */
const FOREIGN_RECORD_FIELDS = new Set(['id_solutto', 'codigo', 'data_criacao', 'historico_data_criacao_solutto'])

const fieldKey = (s: string | null | undefined): string =>
  canonName(s)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

export function isForeignRecordField(f: { label?: string | null; slug?: string | null } | null | undefined): boolean {
  return FOREIGN_RECORD_FIELDS.has(fieldKey(f?.label)) || FOREIGN_RECORD_FIELDS.has(fieldKey(f?.slug))
}

/** Valor que não diz nada (vazio, só espaço, lista vazia) — não vai pro RD. */
function isEmptyValue(v: unknown): boolean {
  if (v == null) return true
  if (typeof v === 'string') return !v.trim()
  if (Array.isArray(v)) return v.every(isEmptyValue)
  return false
}

export interface RdInherited {
  campaignId: string | null
  dealSourceId: string | null
  customFields: { custom_field_id: string; value: unknown }[]
}

/**
 * O que o negócio NOVO herda do negócio RD do card de origem: campanha, fonte
 * e campos personalizados com valor (menos os que identificam registro de
 * outro sistema). Zelo 01/10: o card que a IA abria no comercial chegava no RD
 * sem campanha nem fonte — o relatório de campanha do RD perdia todo lead que
 * passava do pré-vendas pro comercial.
 */
export function inheritFromRdDeal(d: RdDeal | null | undefined): RdInherited {
  if (!d) return { campaignId: null, dealSourceId: null, customFields: [] }
  const customFields: RdInherited['customFields'] = []
  for (const f of d.deal_custom_fields ?? []) {
    const id = f?.custom_field_id || rid(f?.custom_field) || null
    if (!id || isEmptyValue(f.value) || isForeignRecordField(f.custom_field)) continue
    customFields.push({ custom_field_id: id, value: f.value })
  }
  return {
    campaignId: rid(d.campaign) ?? (d.campaign_id || null),
    dealSourceId: rid(d.deal_source) ?? (d.deal_source_id || null),
    customFields,
  }
}

/**
 * Corpo do POST /deals. Formato visto ao vivo (01/10): `campaign` e
 * `deal_source` ficam no TOPO (irmãos de "deal"); `deal_custom_fields` fica
 * DENTRO de "deal". `withCustomFields: false` = a 2ª tentativa, depois que o
 * RD recusou os campos (campo obrigatório de outro funil, opção que não existe
 * mais…) — o negócio nasce sem eles em vez de não nascer.
 */
export function buildRdDealBody(input: {
  name: string
  stageId: string
  ownerId: string | null
  /** Contato NOVO criado junto (só quando o lead ainda não existe no RD). */
  newContact?: { email: string | null; phone: string | null } | null
  inherit?: RdInherited | null
  withCustomFields?: boolean
  withCampaign?: boolean
}): Record<string, unknown> {
  const name = input.name.length >= 2 ? input.name : `Lead ${input.name}`
  const inherit = input.inherit
  const fields = input.withCustomFields !== false ? (inherit?.customFields ?? []) : []
  const body: Record<string, unknown> = {
    deal: {
      name,
      deal_stage_id: input.stageId,
      ...(input.ownerId ? { user_id: input.ownerId } : {}),
      ...(fields.length ? { deal_custom_fields: fields } : {}),
    },
  }
  if (input.withCampaign !== false) {
    if (inherit?.campaignId) body.campaign = { _id: inherit.campaignId }
    if (inherit?.dealSourceId) body.deal_source = { _id: inherit.dealSourceId }
  }
  const c = input.newContact
  if (c && (c.email || c.phone)) {
    body.contacts = [
      {
        name,
        ...(c.email ? { emails: [{ email: c.email }] } : {}),
        ...(c.phone ? { phones: [{ phone: `+${c.phone.replace(/\D/g, '')}`, type: 'cellphone' }] } : {}),
      },
    ]
  }
  return body
}

/**
 * Texto da anotação "de onde veio o lead", gravada UMA vez quando o negócio
 * nasce no RD. Só o que diz algo: "unknown", "(not set)" e afins (o que o RD
 * Marketing grava sem UTM) ficam de fora. Nada útil → null (sem anotação).
 */
export function rdOriginNote(campaign: string | null | undefined, source: string | null | undefined): string | null {
  // usefulOrigin: limpa parte a parte ("Facebook Ads / unknown" → "Facebook
  // Ads") e recusa rótulo do próprio RD CRM ("Tarefa criada no RD Station CRM").
  const parts = [campaign, source]
    .map((v) => usefulOrigin(v).trim())
    .filter(Boolean)
  const uniq = parts.filter((v, i) => parts.findIndex((p) => canonName(p) === canonName(v)) === i)
  return uniq.length ? `Origem do lead (FluxiaCRM): ${uniq.join(' · ')}`.slice(0, 500) : null
}

/**
 * `deal_lost_note` da perda: "Via FluxiaCRM" + o motivo (só quando o RD não
 * tem um com o MESMO nome — caiu em "Outros" ou no parecido) + o comentário de
 * quem perdeu ([[PERDER:motivo | comentário]] da IA, ou o da tela). Sem nada a
 * acrescentar, fica "Via FluxiaCRM" — como sempre foi.
 */
export function rdLostNote(input: { reason: string | null | undefined; reasonMatchedExactly: boolean; note?: string | null }): string {
  const reason = (input.reason ?? '').trim()
  const parts = [
    'Via FluxiaCRM',
    !input.reasonMatchedExactly && reason ? reason.slice(0, 200) : '',
    (input.note ?? '').trim(),
  ].filter(Boolean)
  return parts.join(' — ').slice(0, 500)
}
