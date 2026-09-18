// ============================================================
// Mapa FluxiaCRM ↔ RD Station CRM — puro (sem banco, sem rede).
//
// Os funis foram espelhados com o MESMO nome e as mesmas etapas nos dois
// lados; o casamento é pelo nome, sem acento e sem caixa ("NOVO LEAD" ≡ "Novo
// lead", "ENVIO DA COF" ≡ "Envio da COF"). Funil daqui sem par lá (ex.: o
// "Funil de vendas" padrão) simplesmente não sincroniza.
// ============================================================

import { rid, type RdPipeline } from './client'

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
    for (const s of p.deal_stages ?? []) {
      const stageId = rid(s)
      if (!stageId) continue
      const ref = { pipelineId, pipelineName: p.name ?? '', stageId, stageName: s.name ?? '' }
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
  const want = canonName(reason)
  const hit = want ? reasons.find((r) => canonName(r.name) === want) : undefined
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
