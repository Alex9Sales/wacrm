// ============================================================
// ingestLead — o NÚCLEO de "um lead vira lead de verdade dentro do CRM".
//
// Uma chamada transforma um lead (formulário, anúncio do TikTok, anúncio do
// Meta) em:
//   1. contato (telefone normalizado E.164, dedupe com advisory-lock);
//   2. card/negócio no Kanban (funil+etapa padrão, ou o informado);
//   3. tarefa de follow-up ligada ao contato + card;
//   4. etiquetas úteis (origem/campanha) — unidas às existentes, nunca apaga;
//   5. (opcional) um WhatsApp de abertura num canal — que joga o lead no
//      inbox onde a IA (se ligada no canal) assume quando o lead responder.
//
// É o MESMO caminho do POST /api/v1/leads (que agora chama isto), então um
// lead de anúncio se comporta exatamente como um digitado à mão. Os passos
// 2–5 são BEST-EFFORT: falhar ali nunca perde o contato.
// ============================================================

import { and, desc, eq } from 'drizzle-orm'

import { db, dealEvents, deals, notifications, tasks } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { pickAssignee } from '@/lib/leads/distribution'
import { normalizeInboundPhoneBR } from '@/lib/whatsapp/phone-utils'
import {
  findOrCreateContact,
  setContactTags,
  loadTagsByContact,
} from '@/lib/api/v1/contacts'
import { firstPipelineOf, firstStageOf } from '@/lib/api/v1/deals'
import { autoCreateStageTasks } from '@/lib/pipelines/stage-tasks'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'

export interface IngestLeadInput {
  /** Telefone cru (será normalizado p/ E.164, ciente do formato BR). */
  rawPhone: string
  name?: string | null
  email?: string | null
  company?: string | null
  /** Bloco de observações já montado (vai pras notas do card + descrição da tarefa). */
  notes?: string | null
  /** Observação pro HISTÓRICO do card (timeline "anotações") — o padrão que o
   *  cliente vê como "observação". undefined = usa `notes`; '' = NÃO gravar
   *  (o chamador cuida do próprio evento, ex.: /diagnostico). */
  historyNote?: string | null
  /**
   * Força criar card NOVO mesmo que o contato já tenha um aberto no funil.
   * Padrão (false) = comportamento RD: anexa ao card existente.
   */
  allowDuplicateDeal?: boolean
  /** Etiquetas a aplicar (unidas às já existentes no contato). */
  tags?: string[]
  /** Funil/etapa de destino (null → primeiro funil/etapa da conta). */
  pipelineId?: string | null
  stageId?: string | null
  /** Sufixo do título da tarefa: `Falar com X — <taskSuffix>`. */
  taskSuffix?: string
  /** Nota padrão do card quando `notes` vem vazio. */
  fallbackNote?: string
  /** WhatsApp de abertura (best-effort). Só dispara se `introText` vier. */
  introText?: string | null
  /** Canal p/ o WhatsApp de abertura (null → resolve automaticamente). */
  channelId?: string | null
  /** Origem estruturada do lead (Site/Instagram/Indicação/…) → deals.origin. */
  origin?: string | null
  /** Fonte/detalhe livre (ex.: nome da campanha) → deals.source. */
  source?: string | null
  /** Responsável explícito. Se vazio, usa o rodízio (distribuição automática). */
  assignedTo?: string | null
}

export interface IngestLeadResult {
  contactId: string
  contactCreated: boolean
  dealId: string | null
  taskId: string | null
  tagsApplied: string[]
  whatsappSent: boolean
}

/** Erro de telefone inválido — o chamador mapeia p/ 400/ignora conforme o caso. */
export class LeadPhoneError extends Error {
  constructor(message = 'Telefone inválido — não foi possível criar o contato') {
    super(message)
    this.name = 'LeadPhoneError'
  }
}

export async function ingestLead(
  accountId: string,
  auditUserId: string,
  input: IngestLeadInput,
): Promise<IngestLeadResult> {
  // 1) Contato — telefone é a chave. Normaliza (corrige o "0 + operadora +
  //    DDD" do BR) antes do find-or-create validar E.164.
  const phone = normalizeInboundPhoneBR(input.rawPhone)
  const name = input.name?.trim() || undefined
  const email = input.email?.trim() || undefined
  const company = input.company?.trim() || undefined

  let contactId: string
  let contactCreated: boolean
  try {
    const c = await findOrCreateContact(accountId, auditUserId, {
      phone,
      name,
      email,
      company,
    })
    contactId = c.id
    contactCreated = c.created
  } catch {
    throw new LeadPhoneError()
  }

  const notes = input.notes?.trim() || null
  const displayName = name || phone
  const fallbackNote = input.fallbackNote || 'Lead.'
  const taskSuffix = input.taskSuffix || 'lead'

  // 2) Card/negócio no Kanban (best-effort).
  let dealId: string | null = null
  /** true = reaproveitamos o card aberto do contato em vez de criar outro. */
  let dealReused = false
  // Responsável: explícito, senão o rodízio (distribuição automática). Null =
  // rodízio desligado / sem membros → cai sem dono, como antes.
  let assignee: string | null = null
  try {
    const pipelineId = input.pipelineId || (await firstPipelineOf(accountId))
    const stageId = pipelineId
      ? input.stageId || (await firstStageOf(pipelineId))
      : null
    if (pipelineId && stageId) {
      // 🔁 TRAVA ANTI-DUPLICADO (padrão RD, pedido do Rafael 01/09): se este
      // contato JÁ tem card ABERTO neste funil, a submissão nova NÃO vira
      // outro card — ela é ANEXADA ao card existente (a observação entra no
      // histórico dele logo abaixo). Sem isso, o mesmo lead preenchendo o
      // formulário 2x virava dois "Lead — Fulano" lado a lado no Kanban.
      // Card ganho/perdido não conta: aí um contato que volta merece card novo.
      const reused = input.allowDuplicateDeal
        ? null
        : firstOrNull(
            await db
              .select({ id: deals.id })
              .from(deals)
              .where(
                and(
                  eq(deals.accountId, accountId),
                  eq(deals.contactId, contactId),
                  eq(deals.pipelineId, pipelineId),
                  eq(deals.status, 'open'),
                ),
              )
              .orderBy(desc(deals.createdAt))
              .limit(1),
          )
      if (reused) {
        dealId = reused.id
        dealReused = true
      }
      assignee =
        input.assignedTo ?? (await pickAssignee(accountId).catch(() => null))
      const inserted = dealReused ? null : firstOrNull(
        await db
          .insert(deals)
          .values({
            userId: auditUserId,
            accountId,
            pipelineId,
            stageId,
            contactId,
            assignedTo: assignee,
            title: `Lead — ${displayName}`,
            value: '0',
            notes: notes || fallbackNote,
            origin: input.origin?.trim() || null,
            source: input.source?.trim() || null,
          })
          .returning({ id: deals.id }),
      )
      if (!dealReused) dealId = inserted?.id ?? null
      // Atividades automáticas da etapa de entrada (best-effort).
      if (dealId) {
        // 📝 Observações do lead → HISTÓRICO do card (timeline "anotações"),
        // padronizado pra TODA origem (API/n8n, anúncio, formulário, chat) —
        // não só despejado no campo Observações. Pedido do Rafael: formulário
        // de fora tem que cair igual ao do CRM.
        const historyText =
          input.historyNote === undefined
            ? notes
            : input.historyNote?.trim() || null
        if (historyText) {
          try {
            const originLabel =
              input.origin?.trim() || input.source?.trim() || 'Formulário'
            await db.insert(dealEvents).values({
              accountId,
              dealId,
              actorUserId: auditUserId,
              type: 'note',
              data: {
                text: dealReused
                  ? `📝 ${originLabel} — NOVA submissão do mesmo lead (anexada a este card):\n${historyText}`
                  : `📝 ${originLabel} — dados do lead:\n${historyText}`,
              },
            })
          } catch (err) {
            console.error('[ingestLead] history note failed:', err)
          }
        }
        try {
          // Card reaproveitado já recebeu as tarefas de entrada quando nasceu
          // (e pode já ter avançado de etapa) — não recria.
          if (!dealReused) {
            await autoCreateStageTasks({ accountId, userId: auditUserId }, dealId, stageId)
          }
        } catch (err) {
          console.error('[ingestLead] autoCreateStageTasks:', err)
        }
        // Distribuição: registra no histórico + notifica o responsável.
        // Card reaproveitado NÃO é redistribuído — ele já tem dono, e trocar
        // por rodízio roubaria o lead de quem já está tocando.
        if (assignee && !dealReused) {
          try {
            await db.insert(dealEvents).values({
              accountId,
              dealId,
              actorUserId: auditUserId,
              type: 'note',
              data: { text: '🎯 Lead distribuído automaticamente (rodízio).' },
            })
            if (assignee !== auditUserId) {
              // Reusa 'deal_transferred' (a CHECK do notifications só aceita
              // tipos conhecidos); o título/corpo dão o sentido de "lead novo".
              await db.insert(notifications).values({
                accountId,
                userId: assignee,
                type: 'deal_transferred',
                dealId,
                contactId,
                actorUserId: auditUserId,
                title: 'Novo lead pra você',
                body: `${displayName} caiu no seu funil.`,
              })
            }
          } catch (err) {
            console.error('[ingestLead] distribution notify failed:', err)
          }
        }
      }
    }
  } catch (err) {
    console.error('[ingestLead] deal create failed:', err)
  }

  // 3) Tarefa de follow-up (best-effort).
  let taskId: string | null = null
  try {
    const inserted = firstOrNull(
      await db
        .insert(tasks)
        .values({
          accountId,
          title: `Falar com ${displayName} — ${taskSuffix}`,
          description: notes,
          type: 'follow_up',
          status: 'open',
          contactId,
          dealId,
          assignedTo: assignee,
          assigneeIds: assignee ? [assignee] : [],
        })
        .returning({ id: tasks.id }),
    )
    taskId = inserted?.id ?? null
  } catch (err) {
    console.error('[ingestLead] task create failed:', err)
  }

  // 4) Etiquetas (best-effort) — união com as existentes, nunca apaga.
  let tagsApplied: string[] = []
  const wanted = input.tags?.filter(Boolean) ?? []
  if (wanted.length) {
    try {
      const current = contactCreated
        ? []
        : ((await loadTagsByContact([contactId])).get(contactId) ?? []).map(
            (t) => t.name,
          )
      const union = [...new Set([...current, ...wanted])]
      await setContactTags(accountId, auditUserId, contactId, union)
      tagsApplied = wanted
    } catch (err) {
      console.error('[ingestLead] tag apply failed:', err)
    }
  }

  // 5) WhatsApp de abertura (best-effort). Abre o thread no inbox; a IA
  //    (se ligada no canal) assume quando o lead responder.
  let whatsappSent = false
  const introText = input.introText?.trim()
  if (introText) {
    try {
      const resolved = await resolveConversationByPhone(
        accountId,
        phone,
        name ?? null,
        input.channelId ?? null,
      )
      await sendMessageToConversation(accountId, {
        conversationId: resolved.conversationId,
        messageType: 'text',
        contentText: introText,
      })
      whatsappSent = true
    } catch (err) {
      console.error('[ingestLead] intro whatsapp failed:', err)
    }
  }

  return { contactId, contactCreated, dealId, taskId, tagsApplied, whatsappSent }
}
