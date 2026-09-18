// ============================================================
// 🔀 IA troca o card de FUNIL ([[FUNIL:<funil> > <etapa>]]) — ferramenta
// 'move_funnel', opt-in por agente.
//
// Caso Zelo 18/09: o RD joga todo lead no funil de pré-vendas de franquia,
// mas chega também quem quer CONTRATAR o serviço e quem procura EMPREGO. A
// Zélia identificava ("não é franquia, vou passar pra equipe") e o card
// ficava parado no funil errado — [[FUNIL:<etapa>]] só anda DENTRO do funil.
//
// Pura (sem banco): casa o texto do marcador com os funis/etapas da conta.
// Funil: nome exato (sem acento/caixa) ou, se não houver, um ÚNICO funil que
// contenha o texto — ambíguo não move. Etapa: exata, senão única que
// contenha, senão a 1ª etapa do funil (entrada padrão).
// ============================================================

export interface FunnelOption {
  id: string
  name: string
  /** Em ordem de posição. */
  stages: { id: string; name: string }[]
}

export interface FunnelTarget {
  pipelineId: string
  pipelineName: string
  stageId: string
  stageName: string
}

const norm = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()

/** "3. Comercial | Serviços > Novo lead" → {funnel, stage}; sem ">" → null. */
export function splitCrossFunnel(raw: string): { funnel: string; stage: string | null } | null {
  const i = raw.lastIndexOf('>')
  if (i < 0) return null
  const funnel = raw.slice(0, i).trim()
  const stage = raw.slice(i + 1).trim()
  if (!funnel) return null
  return { funnel, stage: stage || null }
}

function pickOne<T extends { name: string }>(items: T[], want: string): T | null {
  const w = norm(want)
  const exact = items.find((x) => norm(x.name) === w)
  if (exact) return exact
  const partial = items.filter((x) => norm(x.name).includes(w) || w.includes(norm(x.name)))
  return partial.length === 1 ? partial[0] : null
}

export function resolveFunnelTarget(options: FunnelOption[], raw: string): FunnelTarget | null {
  const s = splitCrossFunnel(raw)
  if (!s) return null
  const funnel = pickOne(options, s.funnel)
  if (!funnel || funnel.stages.length === 0) return null
  const stage = (s.stage ? pickOne(funnel.stages, s.stage) : null) ?? funnel.stages[0]
  return { pipelineId: funnel.id, pipelineName: funnel.name, stageId: stage.id, stageName: stage.name }
}

/** Instrução do prompt: os OUTROS funis da conta e como mover pra eles. */
export function crossFunnelInstruction(funnels: { name: string; stages: string[] }[]): string {
  const list = funnels.map((f) => `"${f.name}" (${f.stages.join(' → ')})`).join('; ')
  return (
    'Moving the card to ANOTHER funnel: besides the linked deal\'s funnel, this account has these funnels: ' +
    list +
    '. Only when the conversation makes it CLEAR that the lead belongs to one of them — a different kind of request than the current funnel handles (for example: they want to HIRE the service instead of what this funnel sells, or they are LOOKING FOR A JOB) — move the card by emitting "[[FUNIL:<funnel name> > <stage name>]]" on its own line, copying EXACTLY one funnel name and one of ITS stages from the list (usually its first stage). Do it once, at the moment it becomes clear; never move it back and forth. This marker is control metadata: never show it to the customer.'
  )
}
