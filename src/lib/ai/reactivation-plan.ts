// ============================================================
// 🔁 Chamar de volta — quem vai por qual canal, hoje (puro, testável).
//
// Pedido do Alex (06/09): o "Chamar de volta" automático tem que funcionar como
// os Disparos de texto — escolher os canais, quantos por canal, espaçamento —
// e parar com aviso se o canal cair. A parte de enviar é do mecanismo dos
// Disparos; aqui só se decide a lista do dia.
//
// Regras:
//   1. quem já tem conversa num dos canais escolhidos vai por ele (continuidade);
//   2. quem não tem vai no canal com mais vaga (equilibra as linhas);
//   3. cada canal recebe no máximo o teto do dia (descontando o que já saiu hoje);
//   4. quem não cabe hoje fica pra amanhã — nunca estoura o teto.
// ============================================================

export interface PlanCandidate {
  contactId: string
  /** Canal da conversa existente, se houver e se for um dos escolhidos. */
  preferredChannelId: string | null
}

export interface PlanChannel {
  channelId: string
  /** Vagas restantes hoje (teto − já enviadas/enfileiradas hoje). */
  remaining: number
}

export interface PlanResult {
  /** channelId → contactIds, na ordem de prioridade recebida. */
  byChannel: Map<string, string[]>
  /** Quantos ficaram de fora por falta de vaga. */
  leftOver: number
}

export function planReactivationBatches(candidates: PlanCandidate[], channels: PlanChannel[]): PlanResult {
  const remaining = new Map(channels.map((c) => [c.channelId, Math.max(0, Math.floor(c.remaining))]))
  const byChannel = new Map<string, string[]>(channels.map((c) => [c.channelId, []]))
  let leftOver = 0
  for (const cand of candidates) {
    let target: string | null = null
    if (cand.preferredChannelId && (remaining.get(cand.preferredChannelId) ?? 0) > 0) {
      target = cand.preferredChannelId
    } else if (!cand.preferredChannelId) {
      // Canal com mais vaga — equilibra as linhas.
      let best = -1
      for (const [id, left] of remaining) {
        if (left > best) {
          best = left
          target = id
        }
      }
      if (best <= 0) target = null
    }
    if (!target) {
      leftOver += 1
      continue
    }
    byChannel.get(target)!.push(cand.contactId)
    remaining.set(target, (remaining.get(target) ?? 1) - 1)
  }
  return { byChannel, leftOver }
}
