// ============================================================
// As duas chaves do agente, e a única combinação que não pode existir.
//
//   • is_active            → "Ativar assistente de IA" (interruptor principal)
//   • auto_reply_enabled   → "Responder automaticamente às mensagens recebidas"
//
// 25/09: a tela desabilitava o segundo interruptor enquanto o primeiro
// estivesse desligado. Quem desligava o assistente com a auto-resposta JÁ
// ligada ficava com ela presa: acesa, cinza, sem aceitar clique — e o
// salvamento gravava a dupla impossível (assistente desligado + auto-resposta
// ligada). O robô de fato parava, porque o roteamento por canal exige
// is_active (ver pickAgentIdForChannel), mas a TELA dizia o contrário: o
// cliente passou a manhã achando que a IA continuava solta nas conversas dele
// e não tinha como provar o contrário.
//
// Assistente desligado = nada da IA roda. A auto-resposta desce junto, aqui,
// para que nenhum caminho de escrita (tela ou API v1) volte a gravar a dupla.
// ============================================================

export interface AgentSwitches {
  isActive: boolean
  autoReplyEnabled: boolean
}

/**
 * Deixa as duas chaves coerentes entre si.
 *
 * Religar o assistente NÃO solta a IA nos clientes de novo: a auto-resposta
 * volta desligada, e quem quiser que ela atenda sozinha liga as duas de
 * propósito. Falhar para o lado do silêncio é barato; o contrário é uma IA
 * conversando com cliente sem ninguém ter pedido.
 */
export function normalizeAgentSwitches(s: AgentSwitches): AgentSwitches {
  return {
    isActive: s.isActive,
    autoReplyEnabled: s.isActive && s.autoReplyEnabled,
  }
}
