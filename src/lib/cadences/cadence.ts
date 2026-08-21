import 'server-only'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'

import {
  db,
  cadences,
  cadenceSteps,
  cadenceEnrollments,
  cadenceEvents,
  scheduledMessages,
  contacts,
  channels,
  conversations,
} from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { findOrCreateConversation } from '@/lib/channels/inbound'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import {
  enqueueScheduledMessage,
  removeScheduledMessageJob,
} from '@/lib/queue/queues'

// ============================================================
// Cadências — motor. Uma CADÊNCIA (sequência de mensagens fixas) é INSCRITA
// num contato (enrollment): cada DEGRAU vira uma scheduled_message no canal
// certo do lead (reusa o motor de agendamento + /agendamentos). Degrau cujo
// canal o lead não tem → PULADO. Pausa quando o lead responde (hook no inbound).
// ============================================================

export type StepChannel = 'whatsapp' | 'email' | 'instagram'

const WHATSAPP_PROVIDERS = ['waha', 'meta', 'evolution', 'evogo']
const EMAIL_PROVIDERS = ['email', 'gmail']
const INSTAGRAM_PROVIDERS = ['instagram']

function providersFor(channel: string): string[] {
  if (channel === 'email') return EMAIL_PROVIDERS
  if (channel === 'instagram') return INSTAGRAM_PROVIDERS
  return WHATSAPP_PROVIDERS
}

function delayMsOf(value: number, unit: string): number {
  const v = Math.max(0, Number(value) || 0)
  if (unit === 'minutes') return v * 60_000
  if (unit === 'hours') return v * 3_600_000
  return v * 86_400_000 // days
}

/** Substitui {{nome}}, {{empresa}}, {{telefone}}, {{email}} no texto. */
export function interpolate(
  text: string | null | undefined,
  vars: Record<string, string>,
): string {
  if (!text) return ''
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[String(k).toLowerCase()] ?? '')
}

interface CadenceCtx {
  accountId: string
  userId: string
}

async function recordCadenceEvent(
  accountId: string,
  enrollment: { id: string; cadenceId: string; contactId: string; dealId: string | null },
  type: string,
  extra?: { stepPosition?: number | null; channel?: string | null; data?: Record<string, unknown> },
): Promise<void> {
  try {
    await db.insert(cadenceEvents).values({
      accountId,
      enrollmentId: enrollment.id,
      cadenceId: enrollment.cadenceId,
      contactId: enrollment.contactId,
      dealId: enrollment.dealId,
      type,
      stepPosition: extra?.stepPosition ?? null,
      channel: extra?.channel ?? null,
      data: (extra?.data ?? {}) as Record<string, unknown>,
    })
  } catch (err) {
    console.error('[cadence] event insert failed:', err)
  }
}

/** Cancela as scheduled_messages PENDENTES de uma inscrição (status cancelled +
 *  remove o job da fila). Usado ao pausar/cancelar/re-inscrever. */
async function cancelPendingSteps(accountId: string, enrollmentId: string): Promise<void> {
  const rows = await db
    .select({ id: scheduledMessages.id })
    .from(scheduledMessages)
    .where(
      and(
        eq(scheduledMessages.accountId, accountId),
        eq(scheduledMessages.cadenceEnrollmentId, enrollmentId),
        eq(scheduledMessages.status, 'pending'),
      ),
    )
  if (rows.length === 0) return
  await db
    .update(scheduledMessages)
    .set({ status: 'cancelled', updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(scheduledMessages.cadenceEnrollmentId, enrollmentId),
        eq(scheduledMessages.status, 'pending'),
      ),
    )
  for (const r of rows) await removeScheduledMessageJob(r.id)
}

/** Encerra uma inscrição (pausa OU cancela) + cancela os degraus pendentes. */
async function endEnrollment(
  accountId: string,
  enrollment: { id: string; cadenceId: string; contactId: string; dealId: string | null },
  status: 'paused' | 'cancelled',
  reason: string,
): Promise<void> {
  await cancelPendingSteps(accountId, enrollment.id)
  await db
    .update(cadenceEnrollments)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(and(eq(cadenceEnrollments.id, enrollment.id), eq(cadenceEnrollments.accountId, accountId)))
  await recordCadenceEvent(accountId, enrollment, status === 'paused' ? 'paused' : 'cancelled', {
    data: { reason },
  })
}

export interface EnrollResult {
  ok: boolean
  enrollmentId?: string
  scheduled?: number
  skipped?: number
  error?: string
}

/**
 * Inscreve um contato numa cadência: agenda cada degrau como scheduled_message
 * no canal certo (pulando os que o lead não tem). Substitui a inscrição ativa
 * anterior do contato (1 cadência ativa por lead).
 */
export async function enrollContactInCadence(
  ctx: CadenceCtx,
  input: {
    cadenceId: string
    contactId: string
    conversationId?: string | null
    dealId?: string | null
  },
): Promise<EnrollResult> {
  try {
    const cadence = firstOrNull(
      await db
        .select({ id: cadences.id, name: cadences.name, active: cadences.active })
        .from(cadences)
        .where(and(eq(cadences.id, input.cadenceId), eq(cadences.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!cadence) return { ok: false, error: 'Cadência não encontrada.' }

    const steps = await db
      .select()
      .from(cadenceSteps)
      .where(
        and(eq(cadenceSteps.cadenceId, input.cadenceId), eq(cadenceSteps.accountId, ctx.accountId)),
      )
      .orderBy(asc(cadenceSteps.position))
    if (steps.length === 0) return { ok: false, error: 'A cadência não tem degraus.' }

    const contact = firstOrNull(
      await db
        .select({
          id: contacts.id,
          userId: contacts.userId,
          name: contacts.name,
          phone: contacts.phone,
          email: contacts.email,
          company: contacts.company,
          externalId: contacts.externalId,
        })
        .from(contacts)
        .where(and(eq(contacts.id, input.contactId), eq(contacts.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!contact) return { ok: false, error: 'Contato não encontrado.' }

    // 1 cadência ativa por lead: encerra a anterior (substituição).
    const prior = firstOrNull(
      await db
        .select({
          id: cadenceEnrollments.id,
          cadenceId: cadenceEnrollments.cadenceId,
          contactId: cadenceEnrollments.contactId,
          dealId: cadenceEnrollments.dealId,
        })
        .from(cadenceEnrollments)
        .where(
          and(
            eq(cadenceEnrollments.contactId, input.contactId),
            eq(cadenceEnrollments.accountId, ctx.accountId),
            eq(cadenceEnrollments.status, 'active'),
          ),
        )
        .limit(1),
    )
    if (prior) await endEnrollment(ctx.accountId, prior, 'cancelled', 'substituída por nova cadência')

    const enrollment = firstOrThrow(
      await db
        .insert(cadenceEnrollments)
        .values({
          accountId: ctx.accountId,
          cadenceId: input.cadenceId,
          contactId: input.contactId,
          conversationId: input.conversationId ?? null,
          dealId: input.dealId ?? null,
          status: 'active',
          enrolledBy: ctx.userId,
        })
        .returning({
          id: cadenceEnrollments.id,
          cadenceId: cadenceEnrollments.cadenceId,
          contactId: cadenceEnrollments.contactId,
          dealId: cadenceEnrollments.dealId,
        }),
    )

    const vars: Record<string, string> = {
      nome: (contact.name ?? '').trim(),
      empresa: (contact.company ?? '').trim(),
      telefone: (contact.phone ?? '').trim(),
      email: (contact.email ?? '').trim(),
    }

    const accountChannels = await db
      .select({ id: channels.id, provider: channels.provider })
      .from(channels)
      .where(eq(channels.accountId, ctx.accountId))

    // Conversas EXISTENTES do lead (por provider). Base do roteamento: mandar no
    // canal REAL do lead, não num canal qualquer da família (Felipe tem 8 WA).
    const existingConvs = await db
      .select({
        id: conversations.id,
        channelId: conversations.channelId,
        provider: channels.provider,
      })
      .from(conversations)
      .innerJoin(channels, eq(channels.id, conversations.channelId))
      .where(
        and(
          eq(conversations.accountId, ctx.accountId),
          eq(conversations.contactId, input.contactId),
        ),
      )
    // Conversa de origem (a que acionou a cadência), se veio de uma.
    const originConv = input.conversationId
      ? existingConvs.find((c) => c.id === input.conversationId) ?? null
      : null

    let scheduled = 0
    let skipped = 0
    let cumMs = 0
    for (const step of steps) {
      cumMs += delayMsOf(step.delayValue, step.delayUnit)
      const providers = providersFor(step.channel)

      // Alvo: a conversa REAL do lead nesse canal. Prefere a de origem (se do
      // mesmo provider), senão qualquer conversa existente do provider.
      let targetConvId: string | null =
        originConv && providers.includes(originConv.provider) ? originConv.id : null
      if (!targetConvId) {
        const ex = existingConvs.find((c) => providers.includes(c.provider))
        if (ex) targetConvId = ex.id
      }

      if (step.channel === 'instagram') {
        // external_id é AMBÍGUO (guarda e-mail p/ contatos de e-mail, PSID p/
        // Messenger, IGSID p/ Instagram). Só manda no IG se o lead JÁ tem uma
        // conversa de Instagram — prova que é IGSID de verdade. Senão, pula.
        if (!targetConvId) {
          skipped++
          await recordCadenceEvent(ctx.accountId, enrollment, 'step_skipped', {
            stepPosition: step.position,
            channel: step.channel,
            data: { reason: 'lead não está no Instagram' },
          })
          continue
        }
      } else {
        // WhatsApp/E-mail: precisa do campo (telefone/e-mail). Se ainda não tem
        // conversa nesse canal, abre uma no canal certo (prefere o de origem).
        const hasField = step.channel === 'email' ? !!vars.email : !!vars.telefone
        if (!hasField) {
          skipped++
          await recordCadenceEvent(ctx.accountId, enrollment, 'step_skipped', {
            stepPosition: step.position,
            channel: step.channel,
            data: { reason: 'lead sem o campo do canal' },
          })
          continue
        }
        if (!targetConvId) {
          const channelId =
            originConv && providers.includes(originConv.provider)
              ? originConv.channelId
              : accountChannels.find((c) => providers.includes(c.provider))?.id ?? null
          if (!channelId) {
            skipped++
            await recordCadenceEvent(ctx.accountId, enrollment, 'step_skipped', {
              stepPosition: step.position,
              channel: step.channel,
              data: { reason: 'sem canal' },
            })
            continue
          }
          const conv = await findOrCreateConversation(
            ctx.accountId,
            contact.userId,
            input.contactId,
            channelId,
          )
          if (!conv) {
            skipped++
            await recordCadenceEvent(ctx.accountId, enrollment, 'step_skipped', {
              stepPosition: step.position,
              channel: step.channel,
              data: { reason: 'não abriu conversa' },
            })
            continue
          }
          targetConvId = conv.conversation.id
        }
      }

      // >=60s à frente (o agendamento exige futuro; D0 sai em ~1 min).
      const sendAt = new Date(Date.now() + Math.max(cumMs, 60_000))
      const body = interpolate(step.body, vars)
      const subject = step.channel === 'email' ? interpolate(step.subject, vars) || null : null

      let insertedId: string | null = null
      try {
        const row = firstOrThrow(
          await db
            .insert(scheduledMessages)
            .values({
              accountId: ctx.accountId,
              conversationId: targetConvId,
              contactId: input.contactId,
              messageType: 'text',
              contentText: body,
              subject,
              scheduledAt: sendAt.toISOString(),
              status: 'pending',
              createdBy: ctx.userId,
              assignedTo: ctx.userId,
              assignedBy: ctx.userId,
              cadenceEnrollmentId: enrollment.id,
              cadenceStepPosition: step.position,
            })
            .returning({ id: scheduledMessages.id }),
        )
        insertedId = row.id
        await enqueueScheduledMessage(row.id, { delayMs: sendAt.getTime() - Date.now() })
        scheduled++
        await recordCadenceEvent(ctx.accountId, enrollment, 'step_scheduled', {
          stepPosition: step.position,
          channel: step.channel,
          data: { scheduledAt: sendAt.toISOString(), scheduledMessageId: row.id },
        })
      } catch (err) {
        // Rollback do row órfão se o enqueue falhou.
        if (insertedId) {
          await db.delete(scheduledMessages).where(eq(scheduledMessages.id, insertedId)).catch(() => {})
        }
        console.error('[cadence] agendar degrau falhou:', err)
        skipped++
      }
    }

    await recordCadenceEvent(ctx.accountId, enrollment, 'enrolled', {
      data: { cadence: cadence.name, scheduled, skipped },
    })

    // Se nada foi agendado (todos pulados), encerra como concluída (nada a fazer).
    if (scheduled === 0) {
      await db
        .update(cadenceEnrollments)
        .set({ status: 'done', updatedAt: new Date().toISOString() })
        .where(eq(cadenceEnrollments.id, enrollment.id))
      await recordCadenceEvent(ctx.accountId, enrollment, 'completed', {
        data: { reason: 'nenhum degrau aplicável (canais/campos ausentes)' },
      })
    }

    return { ok: true, enrollmentId: enrollment.id, scheduled, skipped }
  } catch (err) {
    // Corrida: dois enrolls simultâneos p/ o mesmo contato batem no índice
    // único parcial (contact_id WHERE status='active').
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: 'Este lead acabou de entrar numa cadência. Recarregue e tente de novo.',
      }
    }
    console.error('[cadence] enrollContactInCadence:', err)
    return { ok: false, error: 'Falha ao iniciar a cadência.' }
  }
}

/** Hook do inbound: se o lead respondeu e a cadência tem pause_on_reply, pausa
 *  a inscrição ativa (cancela os degraus pendentes). Best-effort. */
export async function maybePauseCadenceOnReply(
  accountId: string,
  contactId: string,
): Promise<void> {
  try {
    const enr = firstOrNull(
      await db
        .select({
          id: cadenceEnrollments.id,
          cadenceId: cadenceEnrollments.cadenceId,
          contactId: cadenceEnrollments.contactId,
          dealId: cadenceEnrollments.dealId,
          pauseOnReply: cadences.pauseOnReply,
        })
        .from(cadenceEnrollments)
        .innerJoin(cadences, eq(cadences.id, cadenceEnrollments.cadenceId))
        .where(
          and(
            eq(cadenceEnrollments.accountId, accountId),
            eq(cadenceEnrollments.contactId, contactId),
            eq(cadenceEnrollments.status, 'active'),
          ),
        )
        .limit(1),
    )
    if (!enr || !enr.pauseOnReply) return
    await endEnrollment(accountId, enr, 'paused', 'lead respondeu')
  } catch (err) {
    console.error('[cadence] maybePauseCadenceOnReply:', err)
  }
}

/** Cancela a inscrição (ação manual). */
export async function cancelEnrollment(
  accountId: string,
  enrollmentId: string,
): Promise<boolean> {
  const enr = firstOrNull(
    await db
      .select({
        id: cadenceEnrollments.id,
        cadenceId: cadenceEnrollments.cadenceId,
        contactId: cadenceEnrollments.contactId,
        dealId: cadenceEnrollments.dealId,
        status: cadenceEnrollments.status,
      })
      .from(cadenceEnrollments)
      .where(and(eq(cadenceEnrollments.id, enrollmentId), eq(cadenceEnrollments.accountId, accountId)))
      .limit(1),
  )
  if (!enr) return false
  await endEnrollment(accountId, enr, 'cancelled', 'cancelada manualmente')
  return true
}

/** Conclui a inscrição se não sobrou NENHUM degrau pendente (enviados, ou
 *  cancelados por opt-out, ou falhados). Chamado pelo worker sempre que um
 *  degrau de cadência termina (enviado/opt-out/falha permanente). */
export async function finalizeEnrollmentIfDrained(
  accountId: string,
  enrollmentId: string,
): Promise<void> {
  try {
    const enr = firstOrNull(
      await db
        .select({
          id: cadenceEnrollments.id,
          cadenceId: cadenceEnrollments.cadenceId,
          contactId: cadenceEnrollments.contactId,
          dealId: cadenceEnrollments.dealId,
          status: cadenceEnrollments.status,
        })
        .from(cadenceEnrollments)
        .where(
          and(
            eq(cadenceEnrollments.id, enrollmentId),
            eq(cadenceEnrollments.accountId, accountId),
          ),
        )
        .limit(1),
    )
    if (!enr || enr.status !== 'active') return
    const pending = firstOrNull(
      await db
        .select({ id: scheduledMessages.id })
        .from(scheduledMessages)
        .where(
          and(
            eq(scheduledMessages.cadenceEnrollmentId, enrollmentId),
            eq(scheduledMessages.status, 'pending'),
          ),
        )
        .limit(1),
    )
    if (pending) return
    await db
      .update(cadenceEnrollments)
      .set({ status: 'done', updatedAt: new Date().toISOString() })
      .where(eq(cadenceEnrollments.id, enrollmentId))
    await recordCadenceEvent(accountId, enr, 'completed', {
      data: { reason: 'sem degraus pendentes' },
    })
  } catch (err) {
    console.error('[cadence] finalizeEnrollmentIfDrained:', err)
  }
}

/** Marca um degrau como enviado + conclui a inscrição se foi o último pendente.
 *  Chamado pelo worker de agendamento ao enviar uma scheduled_message de cadência. */
export async function onCadenceStepSent(
  scheduledMessageId: string,
  accountId: string,
  enrollmentId: string,
  stepPosition: number | null,
): Promise<void> {
  try {
    const enr = firstOrNull(
      await db
        .select({
          id: cadenceEnrollments.id,
          cadenceId: cadenceEnrollments.cadenceId,
          contactId: cadenceEnrollments.contactId,
          dealId: cadenceEnrollments.dealId,
        })
        .from(cadenceEnrollments)
        .where(
          and(
            eq(cadenceEnrollments.id, enrollmentId),
            eq(cadenceEnrollments.accountId, accountId),
          ),
        )
        .limit(1),
    )
    if (enr) {
      await recordCadenceEvent(accountId, enr, 'step_sent', {
        stepPosition,
        data: { scheduledMessageId },
      })
    }
    await finalizeEnrollmentIfDrained(accountId, enrollmentId)
  } catch (err) {
    console.error('[cadence] onCadenceStepSent:', err)
  }
}
