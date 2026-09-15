// ============================================================
// Canais apagados na lista de canais de um agente (ai_configs.auto_reply_channel_ids).
//
// 15/09 (produção): agentes guardavam id de canal que não existe mais — CEMA
// "Agente principal" (default) com 1 id e 0 válidos, Zelia 4/1, GoLink 2/1.
// A regra de roteamento (agents.ts pickAgentIdForChannel, inbound.ts) diz que
// lista VAZIA num agente default = responde em TODOS os canais. Então limpar o
// id apagado às cegas pode transformar "não responde em canal nenhum" em
// "responde em todos" — o pior erro possível. Regra: só tira o id quando sobra
// pelo menos 1 canal que existe; senão não mexe (e a tela avisa).
//
// Puro (sem banco): usado pelo DELETE de /api/channels/[id] e pela tela do agente.
// ============================================================

function asSet(ids: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  return ids instanceof Set ? ids : new Set(ids as readonly string[])
}

/**
 * Lista nova do agente depois de apagar `deletedId`, ou null quando NÃO deve
 * mexer: o id nem estava na lista, ou tirar deixaria o agente sem nenhum canal
 * válido (lista só com apagados, ou vazia = "todos os canais").
 * `existingIds` = canais que existem na conta (o apagado nunca conta como válido).
 */
export function removeDeletedChannel(
  ids: readonly string[] | null | undefined,
  deletedId: string,
  existingIds: ReadonlySet<string> | readonly string[],
): string[] | null {
  const list = ids ?? []
  if (!list.includes(deletedId)) return null
  const existing = asSet(existingIds)
  const next = list.filter((id) => id !== deletedId)
  // `next` já não tem o apagado: mesmo se `existingIds` vier de antes do DELETE,
  // ele não conta como válido.
  return next.some((id) => existing.has(id)) ? next : null
}

export interface AgentChannelsHealth {
  /** Ids na lista do agente. */
  total: number
  /** Ids que existem na conta. */
  valid: number
  /** Ids de canais apagados. */
  deleted: number
  /** Lista não vazia sem nenhum canal válido: o agente não responde em lugar nenhum. */
  respondsNowhere: boolean
}

/** Resumo pra tela do agente ("1 canal desta lista foi apagado"). */
export function agentChannelsHealth(
  ids: readonly string[] | null | undefined,
  existingIds: ReadonlySet<string> | readonly string[],
): AgentChannelsHealth {
  const list = Array.from(new Set(ids ?? []))
  const existing = asSet(existingIds)
  const valid = list.filter((id) => existing.has(id)).length
  return {
    total: list.length,
    valid,
    deleted: list.length - valid,
    respondsNowhere: list.length > 0 && valid === 0,
  }
}
