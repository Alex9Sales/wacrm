import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'

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
import { contactTokenValues, renderMessageVars } from '@/lib/whatsapp/message-vars'

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

/**
 * Substitui {{nome}}, {{primeiro_nome}}, {{empresa}}, {{telefone}}, {{email}}
 * no texto. Reusa o motor CANÔNICO de variáveis (o mesmo do disparo e do
 * agendamento), então: aceita a chave simples {nome}, o fallback
 * {{primeiro_nome|cliente}}, e — crítico — deixa um token DESCONHECIDO
 * VISÍVEL no lugar de apagá-lo. A versão antiga só conhecia 4 tokens e
 * SUMIA com {{primeiro_nome}} (chamado do Rafael 26/08: "exclui e não manda
 * nada").
 */
export function interpolate(
  text: string | null | undefined,
  vars: Record<string, string>,
): string {
  if (!text) return ''
  return renderMessageVars(text, vars)
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

type CadenceStepRow = typeof cadenceSteps.$inferSelect

interface RoutingContext {
  accountChannels: { id: string; provider: string }[]
  existingConvs: { id: string; channelId: string | null; provider: string }[]
  originConv: { id: string; channelId: string | null; provider: string } | null
}

/** Contexto de roteamento: canais da conta + conversas EXISTENTES do lead (por
 *  provider) + a conversa de origem. Base pra mandar cada degrau no canal REAL
 *  do lead (não num canal qualquer da família — Felipe tem 8 WA). Reusado por
 *  enroll e resume. */
async function loadRoutingContext(
  accountId: string,
  contactId: string,
  conversationId: string | null,
): Promise<RoutingContext> {
  const accountChannels = await db
    .select({ id: channels.id, provider: channels.provider })
    .from(channels)
    .where(eq(channels.accountId, accountId))
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
        eq(conversations.accountId, accountId),
        eq(conversations.contactId, contactId),
      ),
    )
  const originConv = conversationId
    ? existingConvs.find((c) => c.id === conversationId) ?? null
    : null
  return { accountChannels, existingConvs, originConv }
}

interface SchedulableContact {
  id: string
  userId: string
  name: string | null
  phone: string | null
  email: string | null
  company: string | null
}

/** Agenda uma lista de degraus como scheduled_messages sob uma inscrição:
 *  roteia pro canal certo (pula o que o lead não tem), interpola as variáveis
 *  e enfileira. `sendAtMsFor` decide QUANDO cada degrau sai (epoch ms). Reusado
 *  por enroll (offset desde o início) e resume (offset relativo à retomada). */
async function scheduleCadenceSteps(
  ctx: CadenceCtx,
  enrollment: { id: string; cadenceId: string; contactId: string; dealId: string | null },
  contact: SchedulableContact,
  routing: RoutingContext,
  steps: CadenceStepRow[],
  sendAtMsFor: (step: CadenceStepRow) => number,
): Promise<{ scheduled: number; skipped: number }> {
  // Inclui `primeiro_nome` (1ª palavra do nome). contactTokenValues é a fonte
  // única (mesmos tokens do disparo/agendamento).
  const vars = contactTokenValues({
    name: contact.name,
    phone: contact.phone,
    email: contact.email,
    company: contact.company,
  })
  let scheduled = 0
  let skipped = 0
  for (const step of steps) {
    const providers = providersFor(step.channel)

    // Alvo: a conversa REAL do lead nesse canal. Prefere a de origem (se do
    // mesmo provider), senão qualquer conversa existente do provider.
    let targetConvId: string | null =
      routing.originConv && providers.includes(routing.originConv.provider)
        ? routing.originConv.id
        : null
    if (!targetConvId) {
      const ex = routing.existingConvs.find((c) => providers.includes(c.provider))
      if (ex) targetConvId = ex.id
    }

    if (step.channel === 'instagram') {
      // external_id é AMBÍGUO (e-mail p/ e-mail, PSID p/ Messenger, IGSID p/ IG).
      // Só manda no IG se o lead JÁ tem conversa de Instagram. Senão, pula.
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
      // WhatsApp/E-mail: precisa do campo (telefone/e-mail). Sem conversa no
      // canal → abre uma no canal certo (prefere o de origem).
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
          routing.originConv && providers.includes(routing.originConv.provider)
            ? routing.originConv.channelId
            : routing.accountChannels.find((c) => providers.includes(c.provider))?.id ?? null
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
          enrollment.contactId,
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

    const sendAt = new Date(sendAtMsFor(step))
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
            contactId: enrollment.contactId,
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
  return { scheduled, skipped }
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

    const routing = await loadRoutingContext(
      ctx.accountId,
      input.contactId,
      input.conversationId ?? null,
    )

    // Cada degrau agenda a partir do INÍCIO da cadência (d0, d2, d4…), NÃO
    // "N depois do degrau anterior" (chamado do Rafael 26/08). O rótulo do
    // editor (+2d/+4d/+7d) já era absoluto; era o motor que somava (d0→d2→d6→
    // d13…). Piso de 60s (o agendamento exige futuro; D0 sai em ~1 min).
    const enrolledAtMs = Date.now()
    const { scheduled, skipped } = await scheduleCadenceSteps(
      ctx,
      enrollment,
      contact,
      routing,
      steps,
      (step) => enrolledAtMs + Math.max(delayMsOf(step.delayValue, step.delayUnit), 60_000),
    )

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

/**
 * RETOMA uma inscrição PAUSADA (o lead respondeu, a cadência parou): reativa e
 * reagenda SÓ os degraus ainda não enviados, a partir de AGORA, preservando o
 * espaçamento entre eles. Ex.: pausou após o degrau 2 (d2) → os degraus 3/4/5
 * (originais d4/d7/d10) saem agora, +3d, +6d. Não reenvia o que já foi.
 * Recomeçar do zero = re-inscrever no botão de cadência.
 */
export async function resumeEnrollment(
  accountId: string,
  enrollmentId: string,
): Promise<EnrollResult> {
  try {
    const enr = firstOrNull(
      await db
        .select({
          id: cadenceEnrollments.id,
          cadenceId: cadenceEnrollments.cadenceId,
          contactId: cadenceEnrollments.contactId,
          conversationId: cadenceEnrollments.conversationId,
          dealId: cadenceEnrollments.dealId,
          status: cadenceEnrollments.status,
          enrolledBy: cadenceEnrollments.enrolledBy,
        })
        .from(cadenceEnrollments)
        .where(and(eq(cadenceEnrollments.id, enrollmentId), eq(cadenceEnrollments.accountId, accountId)))
        .limit(1),
    )
    if (!enr) return { ok: false, error: 'Inscrição não encontrada.' }
    if (enr.status === 'active') return { ok: false, error: 'A cadência já está ativa.' }
    if (enr.status !== 'paused') {
      return { ok: false, error: 'Só dá pra retomar uma cadência que foi pausada.' }
    }

    // 1 cadência ativa por lead: se já entrou em outra, não retoma esta.
    const otherActive = firstOrNull(
      await db
        .select({ id: cadenceEnrollments.id })
        .from(cadenceEnrollments)
        .where(
          and(
            eq(cadenceEnrollments.accountId, accountId),
            eq(cadenceEnrollments.contactId, enr.contactId),
            eq(cadenceEnrollments.status, 'active'),
          ),
        )
        .limit(1),
    )
    if (otherActive) return { ok: false, error: 'Esse lead já está em outra cadência ativa.' }

    const steps = await db
      .select()
      .from(cadenceSteps)
      .where(and(eq(cadenceSteps.cadenceId, enr.cadenceId), eq(cadenceSteps.accountId, accountId)))
      .orderBy(asc(cadenceSteps.position))
    if (steps.length === 0) return { ok: false, error: 'A cadência não tem degraus.' }

    // Último degrau já ENVIADO nessa inscrição — retoma daqui pra frente.
    const lastSent = firstOrNull(
      await db
        .select({ pos: sql<number>`max(cadence_step_position)::int` })
        .from(scheduledMessages)
        .where(
          and(
            eq(scheduledMessages.cadenceEnrollmentId, enrollmentId),
            eq(scheduledMessages.status, 'sent'),
          ),
        ),
    )
    const lastSentPos = lastSent?.pos ?? -1
    const remaining = steps.filter((s) => s.position > lastSentPos)
    if (remaining.length === 0) {
      return { ok: false, error: 'Todos os degraus já foram enviados — nada a retomar.' }
    }

    const contact = firstOrNull(
      await db
        .select({
          id: contacts.id,
          userId: contacts.userId,
          name: contacts.name,
          phone: contacts.phone,
          email: contacts.email,
          company: contacts.company,
        })
        .from(contacts)
        .where(and(eq(contacts.id, enr.contactId), eq(contacts.accountId, accountId)))
        .limit(1),
    )
    if (!contact) return { ok: false, error: 'Contato não encontrado.' }

    const routing = await loadRoutingContext(accountId, enr.contactId, enr.conversationId)
    const ctx: CadenceCtx = { accountId, userId: enr.enrolledBy ?? contact.userId }

    // Re-anchor: o 1º degrau restante sai agora; os seguintes mantêm o
    // espaçamento relativo (offset − offset do 1º restante).
    const baseOffset = delayMsOf(remaining[0].delayValue, remaining[0].delayUnit)
    const nowMs = Date.now()
    const { scheduled, skipped } = await scheduleCadenceSteps(
      ctx,
      { id: enr.id, cadenceId: enr.cadenceId, contactId: enr.contactId, dealId: enr.dealId },
      contact,
      routing,
      remaining,
      (step) => nowMs + Math.max(delayMsOf(step.delayValue, step.delayUnit) - baseOffset, 60_000),
    )

    if (scheduled === 0) {
      return {
        ok: false,
        error: 'Não deu pra retomar — o lead não tem os canais dos próximos degraus.',
      }
    }

    await db
      .update(cadenceEnrollments)
      .set({ status: 'active', updatedAt: new Date().toISOString() })
      .where(eq(cadenceEnrollments.id, enr.id))
    await recordCadenceEvent(
      accountId,
      { id: enr.id, cadenceId: enr.cadenceId, contactId: enr.contactId, dealId: enr.dealId },
      'resumed',
      { data: { scheduled, skipped, fromPosition: remaining[0].position } },
    )

    return { ok: true, enrollmentId: enr.id, scheduled, skipped }
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, error: 'Esse lead acabou de entrar noutra cadência. Recarregue.' }
    }
    console.error('[cadence] resumeEnrollment:', err)
    return { ok: false, error: 'Falha ao retomar a cadência.' }
  }
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
