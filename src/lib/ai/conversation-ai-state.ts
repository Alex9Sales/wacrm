// ============================================================
// Estado HONESTO da IA numa conversa — o que o botão do topo mostra.
//
// 15/09 (GoLink, Dra. Helena Teste): o botão dizia "IA on" e a IA não respondia.
// A conversa tinha responsável humano, e o auto-reply (auto-reply.ts) cala a IA
// em toda conversa com responsável — mas nada na tela avisava. Agora o estado
// separa "ligada e respondendo" de "ligada mas esperando o responsável sair".
//
// Mesma ordem dos gates do auto-reply: canal fora da IA > pausada na conversa >
// com responsável > respondendo. Puro (sem banco): roda no servidor
// (getConversationWithContact) e no cliente (recalcula com o toggle otimista e a
// atribuição trocada na hora, sem esperar recarregar a conversa).
// ============================================================

export type ConversationAiState =
  | 'responding'
  | 'waiting_assignee'
  | 'paused'
  | 'channel_off'

export function aiState(input: {
  /** Algum agente ativo com resposta automática atende o canal da conversa. */
  aiActiveChannel: boolean | null | undefined
  /** Toggle "IA off" desta conversa. */
  aiAutoreplyDisabled: boolean | null | undefined
  assignedAgentId: string | null | undefined
}): ConversationAiState {
  if (!input.aiActiveChannel) return 'channel_off'
  if (input.aiAutoreplyDisabled) return 'paused'
  if (input.assignedAgentId) return 'waiting_assignee'
  return 'responding'
}

/** Nome pra frase; sem nome carregado, não inventa. */
function quem(name: string | null | undefined): string {
  const n = name?.trim()
  return n ? n : 'uma pessoa da equipe'
}

/** Dica do botão quando a IA está em espera. */
export function aiWaitingHint(assigneeName: string | null | undefined): string {
  const n = assigneeName?.trim()
  return n
    ? `Com responsável (${n}) a IA não responde. Tire o responsável pra ela voltar.`
    : 'Com responsável a IA não responde. Tire o responsável pra ela voltar.'
}

/** Aviso ao LIGAR a IA numa conversa que tem responsável (toast + nota). */
export function aiEnableWithAssigneeWarning(
  assigneeName: string | null | undefined,
): string {
  return `A conversa está com ${quem(assigneeName)}: enquanto tiver responsável a IA não responde.`
}
