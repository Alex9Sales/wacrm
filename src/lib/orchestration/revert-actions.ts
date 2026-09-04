// ============================================================
// 🔙 Executor da REVERSÃO (worker-reachable, sem 'server-only').
// A matriz de o-que-dá-pra-desfazer está em revert.ts (pura); aqui é o que
// mexe no banco, usando o `revert_state` gravado na hora da execução.
//
// Princípio: só promete voltar o que volta de verdade. Mensagem entregue não
// desfaz — vira correção (pausa a IA na conversa e devolve pro humano).
// ============================================================

import { and, eq, inArray } from 'drizzle-orm'

import {
  db,
  cadenceEnrollments,
  conversations,
  dealProducts,
  collectionsTouches,
  dealProposals,
  deals,
  pipelineStages,
  tasks,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { cancelEnrollment } from '@/lib/cadences/cadence'

import { noteDealEvent } from './actions'
import type { OrchAction } from './policy'
import { REVERT_MATRIX } from './revert'

export interface RevertInput {
  accountId: string
  /** Humano que mandou desfazer (auditoria). */
  actorUserId: string
  action: OrchAction
  dealId: string | null
  conversationId: string | null
  revertState: Record<string, unknown> | null
  /** Motivo em texto livre (opcional). */
  reason: string | null
}

export interface RevertResult {
  ok: boolean
  /** O que foi feito, em português, pro histórico e pro aviso na tela. */
  done: string
  error?: string
}

export async function revertOrchestrationAction(input: RevertInput): Promise<RevertResult> {
  const plan = REVERT_MATRIX[input.action]
  const st = input.revertState ?? {}

  try {
    switch (plan.kind) {
      case 'undo':
        return await undoAction(input, st)

      case 'correct': {
        // Mensagem já entregue: não volta. Tira a IA da frente pro humano assumir.
        // Se era uma cobrança, a régua também PARA neste devedor — senão ela
        // voltaria a cobrar em 3 dias exatamente quem acabou de reclamar.
        const contactId = typeof st.contactId === 'string' ? st.contactId : null
        if (input.action === 'collect_charges' && contactId) {
          await db
            .insert(collectionsTouches)
            .values({ accountId: input.accountId, contactId, paused: true, pausedReason: input.reason ?? 'Cobrança marcada como errada', pausedBy: input.actorUserId })
            .onConflictDoUpdate({
              target: [collectionsTouches.accountId, collectionsTouches.contactId],
              set: { paused: true, pausedReason: input.reason ?? 'Cobrança marcada como errada', pausedBy: input.actorUserId, updatedAt: new Date().toISOString() },
            })
        }
        if (input.conversationId) {
          await db
            .update(conversations)
            .set({ aiAutoreplyDisabled: true })
            .where(and(eq(conversations.id, input.conversationId), eq(conversations.accountId, input.accountId)))
        }
        if (input.dealId) {
          await noteDealEvent(
            input.accountId,
            input.dealId,
            input.actorUserId,
            `⚠️ Mensagem da IA marcada como errada. Ela não pode ser desfeita (o cliente já recebeu); a IA foi pausada nesta conversa para você assumir.${input.reason ? ` Motivo: ${input.reason}` : ''}`,
          )
        }
        return {
          ok: true,
          done: input.action === 'collect_charges' && contactId
            ? 'A mensagem não volta, mas a régua parou neste devedor e a IA foi pausada na conversa — assuma para resolver com o cliente.'
            : input.conversationId
            ? 'A mensagem não volta, mas a IA foi pausada nesta conversa — assuma a conversa para corrigir com o cliente.'
            : 'Registrado como resultado ruim.',
        }
      }

      case 'escalate': {
        if (input.dealId) {
          await noteDealEvent(
            input.accountId,
            input.dealId,
            input.actorUserId,
            `⚠️ Ação da IA marcada como errada, mas a consequência já saiu (documento enviado ou venda registrada) — precisa de tratativa humana.${input.reason ? ` Motivo: ${input.reason}` : ''}`,
          )
        }
        return { ok: true, done: 'Registrado. Como a consequência já saiu, resolva diretamente com o cliente/no card.' }
      }

      case 'note_only':
      default: {
        if (input.dealId) {
          await noteDealEvent(
            input.accountId,
            input.dealId,
            input.actorUserId,
            `🚫 Ação da IA marcada como errada (nada a desfazer).${input.reason ? ` Motivo: ${input.reason}` : ''}`,
          )
        }
        return { ok: true, done: 'Registrado como resultado ruim.' }
      }
    }
  } catch (err) {
    return { ok: false, done: '', error: err instanceof Error ? err.message : String(err) }
  }
}

async function undoAction(input: RevertInput, st: Record<string, unknown>): Promise<RevertResult> {
  switch (input.action) {
    case 'move_deal': {
      const stageId = typeof st.stageId === 'string' ? st.stageId : null
      if (!stageId || !input.dealId) return { ok: false, done: '', error: 'Não guardamos a etapa anterior desta ação.' }
      const stage = firstOrNull(await db.select({ name: pipelineStages.name }).from(pipelineStages).where(eq(pipelineStages.id, stageId)).limit(1))
      const now = new Date().toISOString()
      await db.update(deals).set({ stageId, stageChangedAt: now, updatedAt: now }).where(and(eq(deals.id, input.dealId), eq(deals.accountId, input.accountId)))
      await noteDealEvent(input.accountId, input.dealId, input.actorUserId, `↩️ Movimentação da IA desfeita — negócio devolvido para "${stage?.name ?? 'etapa anterior'}".${input.reason ? ` Motivo: ${input.reason}` : ''}`)
      return { ok: true, done: `Negócio devolvido para "${stage?.name ?? 'a etapa anterior'}".` }
    }

    case 'create_task': {
      const taskId = typeof st.taskId === 'string' ? st.taskId : null
      if (!taskId) return { ok: false, done: '', error: 'Não guardamos qual tarefa foi criada.' }
      await db
        .update(tasks)
        .set({ status: 'canceled', updatedAt: new Date().toISOString() })
        .where(and(eq(tasks.id, taskId), eq(tasks.accountId, input.accountId)))
      if (input.dealId) await noteDealEvent(input.accountId, input.dealId, input.actorUserId, `↩️ Tarefa criada pela IA foi cancelada.${input.reason ? ` Motivo: ${input.reason}` : ''}`)
      return { ok: true, done: 'Tarefa cancelada.' }
    }

    case 'update_follow_up': {
      if (!input.dealId) return { ok: false, done: '', error: 'Ação sem negócio.' }
      const anterior = typeof st.nextFollowUpAt === 'string' ? st.nextFollowUpAt : null
      await db
        .update(deals)
        .set({ nextFollowUpAt: anterior, updatedAt: new Date().toISOString() })
        .where(and(eq(deals.id, input.dealId), eq(deals.accountId, input.accountId)))
      await noteDealEvent(input.accountId, input.dealId, input.actorUserId, `↩️ Data de follow-up restaurada${anterior ? '' : ' (voltou a ficar sem data)'}.`)
      return { ok: true, done: anterior ? 'Data de follow-up restaurada.' : 'Follow-up voltou a ficar sem data.' }
    }

    case 'start_cadence': {
      const enrollmentId = typeof st.enrollmentId === 'string' ? st.enrollmentId : null
      if (!enrollmentId) return { ok: false, done: '', error: 'Não guardamos a inscrição criada.' }
      const ok = await cancelEnrollment(input.accountId, enrollmentId)
      if (!ok) return { ok: false, done: '', error: 'Não foi possível remover da cadência (talvez já tenha terminado).' }
      if (input.dealId) await noteDealEvent(input.accountId, input.dealId, input.actorUserId, `↩️ Contato removido da cadência iniciada pela IA.${input.reason ? ` Motivo: ${input.reason}` : ''}`)
      return { ok: true, done: 'Contato removido da cadência; as mensagens que ainda não saíram foram canceladas.' }
    }

    case 'apply_discount': {
      const proposalId = typeof st.proposalId === 'string' ? st.proposalId : null
      if (!proposalId) return { ok: false, done: '', error: 'Não guardamos a proposta alterada.' }
      const prop = firstOrNull(await db.select({ acceptedAt: dealProposals.acceptedAt }).from(dealProposals).where(eq(dealProposals.id, proposalId)).limit(1))
      if (prop?.acceptedAt) return { ok: false, done: '', error: 'A proposta já foi aceita pelo cliente — mexer no desconto agora precisa de tratativa com ele.' }
      await db
        .update(dealProposals)
        .set({
          discount: typeof st.discount === 'string' ? st.discount : '0',
          discountType: typeof st.discountType === 'string' ? st.discountType : 'value',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(dealProposals.id, proposalId))
      if (input.dealId) await noteDealEvent(input.accountId, input.dealId, input.actorUserId, `↩️ Desconto aplicado pela IA foi revertido.${input.reason ? ` Motivo: ${input.reason}` : ''}`)
      return { ok: true, done: 'Desconto anterior restaurado.' }
    }

    case 'draft_proposal': {
      const proposalId = typeof st.proposalId === 'string' ? st.proposalId : null
      if (!proposalId) return { ok: false, done: '', error: 'Não guardamos a proposta criada.' }
      const prop = firstOrNull(
        await db.select({ acceptedAt: dealProposals.acceptedAt, dealId: dealProposals.dealId }).from(dealProposals).where(eq(dealProposals.id, proposalId)).limit(1),
      )
      if (!prop) return { ok: true, done: 'A proposta já não existe mais.' }
      if (prop.acceptedAt) return { ok: false, done: '', error: 'O cliente já aceitou esta proposta — cancelar agora precisa de tratativa com ele.' }
      await db.delete(dealProposals).where(eq(dealProposals.id, proposalId))
      // O item que a IA lançou junto sai também (o que o time criou fica).
      const dealForItem = typeof st.createdItemForDeal === 'string' ? st.createdItemForDeal : null
      if (dealForItem) {
        const items = await db.select({ id: dealProducts.id }).from(dealProducts).where(eq(dealProducts.dealId, dealForItem))
        if (items.length === 1) await db.delete(dealProducts).where(inArray(dealProducts.id, [items[0].id]))
      }
      if (input.dealId) await noteDealEvent(input.accountId, input.dealId, input.actorUserId, `↩️ Proposta montada pela IA foi cancelada.${input.reason ? ` Motivo: ${input.reason}` : ''}`)
      return { ok: true, done: 'Proposta cancelada.' }
    }

    default:
      return { ok: false, done: '', error: 'Esta ação não tem desfazer.' }
  }
}
