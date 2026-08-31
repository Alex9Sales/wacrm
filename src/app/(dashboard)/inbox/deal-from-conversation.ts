'use server'

// ============================================================
// 🪄 "Criar negócio com IA" (pedido do Alex, 31/08): botão na lateral da
// conversa → a IA LÊ a conversa, extrai título (produto/serviço/agendamento),
// valor e forma de pagamento e PROPÕE o card. O humano confirma/ajusta e só
// então o negócio é criado no funil (1ª etapa — ele arrasta pra onde quiser;
// Ganho registra a venda no histórico como sempre). Nada vai pro cliente.
// Serve pra qualquer nicho — produto, serviço, agendamento.
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, conversations, deals, dealEvents, organization } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { buildConversationContext } from '@/lib/ai/context'
import { firstPipelineOf, firstStageOf } from '@/lib/api/v1/deals'

export interface DealProposal {
  title: string
  value: number | null
  payment: string | null
  address: string | null
  summary: string
}

const EXTRACT_PROMPT = `Você analisa a transcrição de uma conversa entre uma empresa e um cliente e extrai a OPORTUNIDADE/VENDA discutida, para virar um card de CRM. Serve para qualquer nicho: produto, serviço, agendamento, orçamento.

Responda APENAS com um JSON válido neste formato exato:
{"title":"<curto: o que está sendo vendido/contratado, ex. '1 Ultragaz P-13' ou 'Limpeza dental — avaliação'>","value":<número em reais SEM símbolo, ou null se o valor não apareceu na conversa>,"payment":"<dinheiro|pix|débito|crédito|boleto|null se não dito>","address":"<endereço de entrega/atendimento EXATAMENTE como dito na conversa, ou null se não apareceu>","summary":"<1 frase objetiva do que foi combinado, com o que faltar definir>"}

Regras: use SOMENTE o que está na conversa — nunca invente valor nem forma de pagamento (use null). Se houver mais de um item, some no título ("2 P-13"). Título em português, máx. 60 caracteres.`

function parseProposal(text: string): DealProposal | null {
  // Tolera ```json ... ``` e texto ao redor — pega o primeiro objeto {...}.
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, 80) : ''
    if (!title) return null
    const rawValue = o.value
    const value =
      typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0
        ? Math.round(rawValue * 100) / 100
        : null
    const payment =
      typeof o.payment === 'string' && o.payment.trim() && o.payment !== 'null'
        ? o.payment.trim().slice(0, 30)
        : null
    const address =
      typeof o.address === 'string' && o.address.trim() && o.address !== 'null'
        ? o.address.trim().slice(0, 200)
        : null
    const summary =
      typeof o.summary === 'string' ? o.summary.trim().slice(0, 300) : ''
    return { title, value, payment, address, summary }
  } catch {
    return null
  }
}

/** Lê a conversa e devolve a PROPOSTA de card (não cria nada). */
export async function proposeDealFromConversation(
  conversationId: string,
): Promise<{ proposal?: DealProposal; error?: string }> {
  try {
    const ctx = await getCurrentAccount()
    const conv = firstOrNull(
      await db
        .select({ id: conversations.id, contactId: conversations.contactId })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.accountId, ctx.accountId),
          ),
        )
        .limit(1),
    )
    if (!conv) return { error: 'Conversa não encontrada.' }

    const cfg = await loadAiConfig(ctx.accountId, {
      requireActive: false,
    }).catch(() => null)
    if (!cfg) return { error: 'IA não configurada na conta (Agentes IA).' }

    const convo = await buildConversationContext(conversationId).catch(
      () => [],
    )
    if (convo.length === 0)
      return { error: 'A conversa ainda não tem mensagens.' }
    const transcript = convo
      .map(
        (m) =>
          `${m.role === 'user' ? 'CLIENTE' : 'ATENDENTE'}: ${
            typeof m.content === 'string' ? m.content : ''
          }`,
      )
      .join('\n')
      // Conversa gigante: o fim é o que importa (a negociação atual).
      .slice(-12_000)

    const result = await generateReply({
      config: cfg,
      systemPrompt: EXTRACT_PROMPT,
      messages: [{ role: 'user', content: transcript }],
    })
    const proposal = parseProposal(result.text ?? '')
    if (!proposal)
      return {
        error:
          'Não consegui identificar uma venda/oportunidade clara na conversa.',
      }
    return { proposal }
  } catch (err) {
    console.error('[deal-from-conversation] propose failed:', err)
    return { error: 'Falha ao analisar a conversa. Tente de novo.' }
  }
}

/** Cria o negócio a partir da proposta CONFIRMADA pelo humano. */
export async function createDealFromProposal(
  conversationId: string,
  proposal: DealProposal,
): Promise<{ dealId?: string; error?: string }> {
  const title = (proposal.title ?? '').trim().slice(0, 80)
  if (!title) return { error: 'Dê um título ao negócio.' }
  try {
    const ctx = await getCurrentAccount()
    const conv = firstOrNull(
      await db
        .select({ id: conversations.id, contactId: conversations.contactId })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.accountId, ctx.accountId),
          ),
        )
        .limit(1),
    )
    if (!conv?.contactId) return { error: 'Conversa sem contato.' }

    // 💱 Moeda da CONTA (bug 31/08: card nascia em USD, default do schema,
    // mesmo com a conta em BRL).
    const org = firstOrNull(
      await db
        .select({ currency: organization.default_currency })
        .from(organization)
        .where(eq(organization.id, ctx.accountId))
        .limit(1),
    )
    const currency = org?.currency || 'BRL'

    const pipelineId = await firstPipelineOf(ctx.accountId)
    const stageId = pipelineId ? await firstStageOf(pipelineId) : null
    if (!pipelineId || !stageId)
      return { error: 'A conta ainda não tem funil configurado.' }

    const value =
      typeof proposal.value === 'number' && proposal.value > 0
        ? proposal.value
        : 0
    const noteBits = [
      proposal.summary?.trim(),
      proposal.payment ? `Forma de pagamento: ${proposal.payment}` : null,
      proposal.address ? `Endereço: ${proposal.address}` : null,
    ].filter(Boolean)
    const created = firstOrNull(
      await db
        .insert(deals)
        .values({
          userId: ctx.userId,
          accountId: ctx.accountId,
          pipelineId,
          stageId,
          contactId: conv.contactId,
          title,
          value: String(value),
          currency,
          status: 'open',
          origin: 'Análise da conversa (IA)',
          notes: noteBits.join('\n') || null,
        })
        .returning({ id: deals.id }),
    )
    if (!created) return { error: 'Falha ao criar o negócio.' }

    // Timeline: nasce auditável (quem pediu + de onde veio).
    await db.insert(dealEvents).values({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      dealId: created.id,
      type: 'created',
      data: { by: 'ai-assist', title },
    })
    if (noteBits.length > 0) {
      await db.insert(dealEvents).values({
        accountId: ctx.accountId,
        actorUserId: ctx.userId,
        dealId: created.id,
        type: 'note',
        data: {
          text: `🪄 Card gerado pela análise da conversa (confirmado pelo atendente).\n${noteBits.join('\n')}`,
        },
      })
    }
    return { dealId: created.id }
  } catch (err) {
    console.error('[deal-from-conversation] create failed:', err)
    return { error: 'Falha ao criar o negócio.' }
  }
}
