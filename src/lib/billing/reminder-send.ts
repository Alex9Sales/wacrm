// ============================================================
// 📨 Enviar o lembrete DEIXANDO RASTRO (29/09).
//
// Mora fora do worker de propósito: o botão "Enviar lembrete" do /admin usa o
// mesmo caminho. Antes os dois chamavam provider.sendText direto e o resultado
// era o mesmo buraco nos dois lugares.
// Sem 'server-only' — o worker alcança este arquivo.
// ============================================================

import { eq } from 'drizzle-orm'

import { db, member } from '@/db'
import { firstOrNull } from '@/db/helpers'
import type { ChannelCtx } from '@/lib/channels/provider'
import { getProvider } from '@/lib/channels/registry'

/**
 * Envia o lembrete DENTRO de uma conversa do CRM (29/09) — e cai para o envio
 * direto se não der.
 *
 * Por que isto importa: antes o lembrete saía por `provider.sendText`, que fala
 * com a Meta e pronto. A Meta aceitava e devolvia um id, mas esse id não era
 * guardado em lugar nenhum — então a mensagem não aparecia na conversa, o
 * webhook de status (entregue/lido) não tinha onde pousar, e a única prova de
 * que algo saiu era uma linha de log. O Alex perguntou "por que não dá para
 * saber se foi enviado?" e a resposta era essa: dava para saber que a Meta
 * aceitou, não que o cliente recebeu.
 *
 * Mandando pela conversa, o lembrete vira uma mensagem como qualquer outra:
 * aparece no histórico do cliente, recebe os ticks de entrega e pode ser
 * respondida — o que também abre a janela de 24h para a conversa seguinte.
 *
 * O fallback existe porque lembrete de cobrança não pode deixar de sair por
 * causa de um contato que não pôde ser criado. Mas ele AVISA no log qual
 * caminho foi usado, para que "não achei a mensagem" tenha resposta.
 */
export async function enviarRegistrando(
  channel: ChannelCtx,
  provider: ReturnType<typeof getProvider>,
  fone: string,
  texto: string,
  nomeCliente: string,
): Promise<string> {
  try {
    const { findOrCreateContact } = await import('@/lib/api/v1/contacts')
    const { findOrCreateConversation } = await import('@/lib/channels/inbound')
    const { sendMessageToConversation } = await import('@/lib/whatsapp/send-message')

    const dono = await ownerUserIdOf(channel.accountId)
    if (!dono) throw new Error('conta do canal sem usuário para auditoria')

    const contato = await findOrCreateContact(channel.accountId, dono, {
      phone: `+${fone}`,
      name: nomeCliente,
    })
    const conv = await findOrCreateConversation(
      channel.accountId,
      dono,
      contato.id,
      channel.id,
    )
    if (!conv) throw new Error('conversa não resolvida')

    await sendMessageToConversation(channel.accountId, {
      conversationId: conv.conversation.id,
      messageType: 'text',
      contentText: texto,
    })
    return 'na conversa'
  } catch (err) {
    console.warn(
      `[billing-reminders] não consegui registrar na conversa (${
        err instanceof Error ? err.message : 'erro'
      }) — mandando direto pelo canal.`,
    )
    await provider.sendText(channel, fone, texto)
    return 'direto pelo canal (sem registro na conversa)'
  }
}

/** Um usuário da conta do canal, só para assinar a criação do contato. */
async function ownerUserIdOf(accountId: string): Promise<string | null> {
  const row = firstOrNull(
    await db
      .select({ userId: member.userId })
      .from(member)
      .where(eq(member.organizationId, accountId))
      .limit(1),
  )
  return row?.userId ?? null
}

