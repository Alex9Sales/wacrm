// ============================================================
// A IA responde sozinha NESTA conversa? — a mesma regra do auto-reply.
//
// Revisão 15/09 (GoLink): o botão "IA em espera"/"Tirar responsável" aparecia
// em conversa de canal que a IA não atende. A checagem antiga (inbox/actions
// aiRepliesOnChannel) tratava lista de canais VAZIA de QUALQUER agente como
// "atende todos"; o roteamento real (agents.ts pickAgentIdForChannel, usado
// pelo auto-reply) só aceita isso no agente DEFAULT — ou numa conta com um
// agente só. Especialista não-default de lista vazia só assume conversa por
// transferência ([[AGENTE:]] → conversations.ai_agent_id). Resultado: a tela
// prometia que a IA voltaria e ela nunca respondia.
//
// Ordem igual à do auto-reply (auto-reply.ts): agente dono da conversa ativo
// e com auto-resposta → responde; senão, quem o canal roteia.
// Sem `server-only` (lib alcançável pelo worker não pode ter).
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, aiConfigs } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { pickAgentIdForChannel } from './agents'

export async function aiRepliesOnConversation(
  accountId: string,
  conv: { channelId: string | null | undefined; aiAgentId: string | null | undefined },
): Promise<boolean> {
  if (conv.aiAgentId) {
    const owner = firstOrNull(
      await db
        .select({ id: aiConfigs.id })
        .from(aiConfigs)
        .where(
          and(
            eq(aiConfigs.accountId, accountId),
            eq(aiConfigs.id, conv.aiAgentId),
            eq(aiConfigs.isActive, true),
            eq(aiConfigs.autoReplyEnabled, true),
          ),
        )
        .limit(1),
    )
    if (owner) return true
    // Dono apagado/desativado/sem auto-resposta: o auto-reply cai no canal.
  }
  const agentId = await pickAgentIdForChannel(accountId, conv.channelId ?? null, {
    requireAutoReply: true,
  })
  return agentId != null
}
