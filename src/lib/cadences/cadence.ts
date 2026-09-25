import { and, asc, desc, eq, isNotNull, lte, sql } from 'drizzle-orm'

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
  deals,
  dealEvents,
  pipelineStages,
  user,
  aiConfigs,
} from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { findOrCreateConversation } from '@/lib/channels/inbound'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import {
  enqueueScheduledMessage,
  removeScheduledMessageJob,
} from '@/lib/queue/queues'
import { contactTokenValues, renderMessageVars } from '@/lib/whatsapp/message-vars'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { cadenceStopReason, resumeSendAtMs, shiftOutOfQuietHours } from './schedule-rules'
import { delayMsOf } from './step-timing'

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

// ============================================================
// Automação de funil na cadência (opt-in por cadência, pedido do Rafael 26/08).
// Ligada → move o negócio ao inscrever/responder e, ao TERMINAR sem resposta,
// marca perdido + fecha a conversa.
// ============================================================

/**
 * Move o negócio pra `stageId` SE a etapa for do mesmo funil do negócio e
 * estiver À FRENTE da atual (nunca puxa um negócio avançado pra trás). Registra
 * o evento pro Raio-X. Best-effort — nunca derruba a cadência.
 */
async function moveDealForward(
  accountId: string,
  userId: string | null,
  dealId: string,
  stageId: string,
): Promise<void> {
  try {
    const deal = firstOrNull(
      await db
        .select({
          id: deals.id,
          pipelineId: deals.pipelineId,
          stageId: deals.stageId,
          status: deals.status,
        })
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.accountId, accountId)))
        .limit(1),
    )
    if (!deal || deal.status !== 'open') return
    if (deal.stageId === stageId) return
    const stages = await db
      .select({
        id: pipelineStages.id,
        name: pipelineStages.name,
        position: pipelineStages.position,
      })
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, deal.pipelineId))
    const target = stages.find((s) => s.id === stageId)
    if (!target) return // etapa de OUTRO funil — a cadência serve vários, ignora
    const current = stages.find((s) => s.id === deal.stageId)
    // Só pra frente: não regride um negócio que já avançou.
    if (current && target.position <= current.position) return
    await db
      .update(deals)
      .set({ stageId: target.id, stageChangedAt: sql`now()` })
      .where(and(eq(deals.id, dealId), eq(deals.accountId, accountId)))
    try {
      await db.insert(dealEvents).values({
        accountId,
        actorUserId: userId,
        dealId,
        type: 'stage_changed',
        data: { from: current?.name ?? null, to: target.name, by: 'cadence' },
      })
    } catch (err) {
      console.error('[cadence] deal event (stage) falhou:', err)
    }
  } catch (err) {
    console.error('[cadence] moveDealForward:', err)
  }
}

/** Ao inscrever ou o lead responder: se a cadência tem automação + etapa de
 *  "contato feito" + o enrollment tem negócio → move o negócio pra frente. */
async function applyContactedStage(
  accountId: string,
  userId: string | null,
  cad: { funnelAutomation: boolean; contactedStageId: string | null },
  dealId: string | null,
): Promise<void> {
  if (!cad.funnelAutomation || !cad.contactedStageId || !dealId) return
  await moveDealForward(accountId, userId, dealId, cad.contactedStageId)
}

/** Cadência TERMINOU sem o lead responder (todos os toques enviados, nunca
 *  pausou): marca o negócio como perdido + fecha a conversa. Só se a automação
 *  estiver ligada. Best-effort. */
async function onCadenceCompletedWithoutReply(
  accountId: string,
  enr: { cadenceId: string; dealId: string | null; conversationId: string | null },
): Promise<void> {
  try {
    const cad = firstOrNull(
      await db
        .select({ funnelAutomation: cadences.funnelAutomation, lostReason: cadences.lostReason })
        .from(cadences)
        .where(eq(cadences.id, enr.cadenceId))
        .limit(1),
    )
    if (!cad?.funnelAutomation) return
    if (!enr.dealId && !enr.conversationId) return
    // Motivo da cadência (ex.: "Não respondeu", da lista fechada da conta e do
    // RD) — sem motivo configurado, o texto de sempre.
    const reason = cad.lostReason?.trim() || 'Não respondeu à cadência'

    // Perde EM PÉ: negócio ABERTO (por id, senão o mais recente da conversa) →
    // status='lost' + motivo + evento datado (o Raio-X data a perda pelo evento).
    // Inline (sem importar close-actions) p/ manter o motor worker-safe.
    try {
      const deal = firstOrNull(
        await db
          .select({ id: deals.id, stageId: deals.stageId })
          .from(deals)
          .where(
            and(
              eq(deals.accountId, accountId),
              eq(deals.status, 'open'),
              enr.dealId
                ? eq(deals.id, enr.dealId)
                : enr.conversationId
                  ? eq(deals.conversationId, enr.conversationId)
                  : sql`false`,
            ),
          )
          .orderBy(desc(deals.createdAt))
          .limit(1),
      )
      if (deal) {
        const stageName =
          firstOrNull(
            await db
              .select({ name: pipelineStages.name })
              .from(pipelineStages)
              .where(eq(pipelineStages.id, deal.stageId))
              .limit(1),
          )?.name ?? null
        await db.transaction(async (tx) => {
          await tx
            .update(deals)
            .set({ status: 'lost', lostReason: reason })
            .where(and(eq(deals.id, deal.id), eq(deals.accountId, accountId)))
          await tx.insert(dealEvents).values({
            accountId,
            actorUserId: null,
            dealId: deal.id,
            type: 'status_changed',
            data: {
              from: 'open',
              to: 'lost',
              reason,
              stageId: deal.stageId,
              stageName,
              by: 'cadence',
            },
          })
        })
        // 🔀 Funil→funil: a perda automática também abre o negócio de resgate.
        try {
          const { maybeSpawnCrossFunnelDeal } = await import(
            '@/lib/pipelines/cross-funnel'
          )
          await maybeSpawnCrossFunnelDeal(accountId, null, deal.id, 'lost')
        } catch (err) {
          console.error('[cadence] cross-funnel falhou:', err)
        }
      }
    } catch (err) {
      console.error('[cadence] auto-perder falhou:', err)
    }

    // Fecha a conversa de origem.
    if (enr.conversationId) {
      try {
        await db
          .update(conversations)
          .set({ status: 'closed' })
          .where(
            and(
              eq(conversations.id, enr.conversationId),
              eq(conversations.accountId, accountId),
            ),
          )
      } catch (err) {
        console.error('[cadence] auto-fechar conversa falhou:', err)
      }
    }
  } catch (err) {
    console.error('[cadence] onCadenceCompletedWithoutReply:', err)
  }
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
  /** Retomada: quando sai o próximo toque (ISO). */
  nextAt?: string | null
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

/** Como agendar os degraus. Inscrição MANUAL: horário exato. AUTOMÁTICA (lead
 *  que chegou sozinho): nada sai de madrugada (`timezone` liga o silêncio).
 *  Nas duas, a cadência NUNCA põe responsável na conversa: com responsável a IA
 *  não responde, e quem responde ao lead que voltou é a IA (19/09, Rafael:
 *  "deixa sem atribuir, porque eu queria que a IA continuasse"). */
interface ScheduleOptions {
  /** Fuso da conta p/ empurrar o envio pra fora do silêncio (21h–8h → 9h). */
  timezone?: string | null
}

/** Agenda uma lista de degraus como scheduled_messages sob uma inscrição:
 *  roteia pro canal certo (pula o que o lead não tem), interpola as variáveis
 *  e enfileira. `sendAtMsFor` decide QUANDO cada degrau sai (epoch ms). Reusado
 *  por enroll (offset desde o início) e resume (offset relativo à retomada). */
/**
 * O nome que assina a cadência: responsável pelo card > assinatura da conta.
 * Best-effort — sem nenhum dos dois, o token some do texto sozinho.
 */
async function senderName(accountId: string, dealId: string | null): Promise<string | null> {
  try {
    if (dealId) {
      const dono = firstOrNull(
        await db
          .select({ name: user.name })
          .from(deals)
          .innerJoin(user, eq(user.id, deals.assignedTo))
          .where(and(eq(deals.id, dealId), eq(deals.accountId, accountId)))
          .limit(1),
      )
      if (dono?.name?.trim()) return dono.name.trim()
    }
    const cfg = firstOrNull(
      await db
        .select({ name: aiConfigs.signatureName })
        .from(aiConfigs)
        .where(and(eq(aiConfigs.accountId, accountId), eq(aiConfigs.isDefault, true)))
        .limit(1),
    )
    return cfg?.name?.trim() || null
  } catch {
    return null
  }
}

async function scheduleCadenceSteps(
  ctx: CadenceCtx,
  enrollment: { id: string; cadenceId: string; contactId: string; dealId: string | null },
  contact: SchedulableContact,
  routing: RoutingContext,
  steps: CadenceStepRow[],
  sendAtMsFor: (step: CadenceStepRow) => number,
  opts: ScheduleOptions = {},
): Promise<{ scheduled: number; skipped: number; firstAt: string | null }> {
  // Quando sai o 1º toque que REALMENTE ficou agendado (pro aviso na tela).
  let firstAtMs: number | null = null
  // Inclui `primeiro_nome` (1ª palavra do nome). contactTokenValues é a fonte
  // única (mesmos tokens do disparo/agendamento).
  //
  // `{{atendente}}` (25/09, Dra. Joyce): quem assina a mensagem. Numa cadência
  // não tem ninguém apertando enviar — o nome vem do responsável pelo card e,
  // na falta dele, da assinatura da conta. Vazio some do texto sozinho.
  const vars = contactTokenValues(
    {
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      company: contact.company,
    },
    await senderName(ctx.accountId, enrollment.dealId),
  )
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

    const rawSendAt = sendAtMsFor(step)
    const sendAt = new Date(opts.timezone ? shiftOutOfQuietHours(rawSendAt, opts.timezone) : rawSendAt)
    const body = interpolate(step.body, vars)
    const subject = step.channel === 'email' ? interpolate(step.subject, vars) || null : null
    // Modelo só vale no WhatsApp; os parâmetros ficam CRUS ({{primeiro_nome}})
    // e o worker resolve no envio, com o nome do contato daquele momento.
    const templateName = step.channel === 'whatsapp' ? step.templateName?.trim() || null : null

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
            templateName,
            templateLanguage: templateName ? step.templateLanguage?.trim() || 'pt_BR' : null,
            templateParams: templateName ? (step.templateParams ?? []) : null,
            scheduledAt: sendAt.toISOString(),
            status: 'pending',
            createdBy: ctx.userId,
            // Sem responsável: o worker atribuiria a conversa no envio e a IA
            // deixaria de atender a resposta do lead (ver ScheduleOptions).
            assignedTo: null,
            assignedBy: null,
            cadenceEnrollmentId: enrollment.id,
            cadenceStepPosition: step.position,
          })
          .returning({ id: scheduledMessages.id }),
      )
      insertedId = row.id
      await enqueueScheduledMessage(row.id, { delayMs: sendAt.getTime() - Date.now() })
      scheduled++
      if (firstAtMs === null || sendAt.getTime() < firstAtMs) firstAtMs = sendAt.getTime()
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
  return { scheduled, skipped, firstAt: firstAtMs === null ? null : new Date(firstAtMs).toISOString() }
}

/** Inscrição AUTOMÁTICA: nada sai no horário de silêncio do fuso da conta. */
async function automaticScheduleOptions(accountId: string): Promise<ScheduleOptions> {
  let timezone = 'America/Sao_Paulo'
  try {
    timezone = (await getAccountSettings(accountId)).businessTimezone || timezone
  } catch {
    /* fuso padrão */
  }
  return { timezone }
}

/**
 * Inscreve um contato numa cadência: agenda cada degrau como scheduled_message
 * no canal certo (pulando os que o lead não tem). Substitui a inscrição ativa
 * anterior do contato (1 cadência ativa por lead).
 *
 * `automatic`: inscrição feita pelo sistema (ex.: lead do RD depois da
 * abertura) — ninguém vira responsável pela conversa (a IA segue atendendo
 * quando o lead responder) e nada sai no horário de silêncio da conta.
 */
export async function enrollContactInCadence(
  ctx: CadenceCtx,
  input: {
    cadenceId: string
    contactId: string
    conversationId?: string | null
    dealId?: string | null
  },
  opts: { automatic?: boolean } = {},
): Promise<EnrollResult> {
  try {
    const cadence = firstOrNull(
      await db
        .select({
          id: cadences.id,
          name: cadences.name,
          active: cadences.active,
          funnelAutomation: cadences.funnelAutomation,
          contactedStageId: cadences.contactedStageId,
        })
        .from(cadences)
        .where(and(eq(cadences.id, input.cadenceId), eq(cadences.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!cadence) return { ok: false, error: 'Cadência não encontrada.' }
    // Desligar a cadência na tela para as entradas automáticas.
    if (opts.automatic && !cadence.active) return { ok: false, error: 'Cadência desligada.' }

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
    const scheduleOpts: ScheduleOptions = opts.automatic ? await automaticScheduleOptions(ctx.accountId) : {}
    const { scheduled, skipped } = await scheduleCadenceSteps(
      ctx,
      enrollment,
      contact,
      routing,
      steps,
      (step) => enrolledAtMs + Math.max(delayMsOf(step.delayValue, step.delayUnit), 60_000),
      scheduleOpts,
    )

    await recordCadenceEvent(ctx.accountId, enrollment, 'enrolled', {
      data: { cadence: cadence.name, scheduled, skipped, automatic: !!opts.automatic },
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
    } else {
      // 🔁 Automação de funil: inscreveu = "contato feito" → move o negócio.
      await applyContactedStage(ctx.accountId, ctx.userId, cadence, input.dealId ?? null)
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
          enrolledBy: cadenceEnrollments.enrolledBy,
          pauseOnReply: cadences.pauseOnReply,
          funnelAutomation: cadences.funnelAutomation,
          contactedStageId: cadences.contactedStageId,
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
    if (!enr) return
    // 🔁 Automação de funil: o lead respondeu = "contato feito" → move o negócio
    // (mesmo que a cadência não pause; respondeu é sinal comercial).
    await applyContactedStage(
      accountId,
      enr.enrolledBy ?? null,
      { funnelAutomation: enr.funnelAutomation, contactedStageId: enr.contactedStageId },
      enr.dealId,
    )
    // Pausa ao responder OU quando a automação de funil está ligada: se a
    // automação está on e a cadência NÃO pausasse, o lead que respondeu seguiria
    // até o fim e cairia no "perdido" (contraditório). Pausar sela isso — quem
    // respondeu nunca é auto-perdido.
    if (!enr.pauseOnReply && !enr.funnelAutomation) return
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
 * reagenda SÓ os degraus ainda não enviados, no ritmo NORMAL contado da
 * retomada — cada um espera o intervalo que tem em relação ao último enviado
 * (`resumeSendAtMs`). Ex.: D0/+2d/+4d/+7d/+10d, pausou após o D0 → +2d, +4d,
 * +7d, +10d a partir de agora. Não reenvia o que já foi. Inscrição automática
 * segue automática (fora do silêncio). Recomeçar do zero = re-inscrever no
 * botão de cadência.
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

    // Retomar uma inscrição AUTOMÁTICA (lead que chegou sozinho) não pode
    // mandar de madrugada. O jeito da inscrição fica no evento 'enrolled'.
    const enrolledEvt = firstOrNull(
      await db
        .select({ data: cadenceEvents.data })
        .from(cadenceEvents)
        .where(and(eq(cadenceEvents.enrollmentId, enr.id), eq(cadenceEvents.type, 'enrolled')))
        .limit(1),
    )
    const automatic = (enrolledEvt?.data as { automatic?: boolean } | null)?.automatic === true
    const scheduleOpts: ScheduleOptions = automatic ? await automaticScheduleOptions(accountId) : {}

    // Ritmo normal contado da retomada: cada toque espera o intervalo que tem
    // em relação ao último ENVIADO (o anterior mais próximo, se a cadência foi
    // editada). Nada enviado → conta do zero, como na inscrição.
    const lastSentStep = steps.filter((s) => s.position <= lastSentPos).at(-1) ?? null
    const lastSentDelayMs = lastSentStep ? delayMsOf(lastSentStep.delayValue, lastSentStep.delayUnit) : 0
    const nowMs = Date.now()
    const { scheduled, skipped, firstAt } = await scheduleCadenceSteps(
      ctx,
      { id: enr.id, cadenceId: enr.cadenceId, contactId: enr.contactId, dealId: enr.dealId },
      contact,
      routing,
      remaining,
      (step) => resumeSendAtMs(delayMsOf(step.delayValue, step.delayUnit), lastSentDelayMs, nowMs),
      scheduleOpts,
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
      { data: { scheduled, skipped, fromPosition: remaining[0].position, nextAt: firstAt, automatic } },
    )

    return { ok: true, enrollmentId: enr.id, scheduled, skipped, nextAt: firstAt }
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
          conversationId: cadenceEnrollments.conversationId,
          status: cadenceEnrollments.status,
          loseAt: cadenceEnrollments.loseAt,
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
    // Espera antes de perder (ex.: Zelo — "sem resposta 72 h após a Definição
    // → perdido"): a inscrição segue ATIVA até `lose_at`, então uma resposta
    // do lead ainda PAUSA e ele nunca é perdido; quem conclui é a varredura
    // `runCadenceLossSweep`.
    const cad = firstOrNull(
      await db
        .select({ funnelAutomation: cadences.funnelAutomation, loseAfterHours: cadences.loseAfterHours })
        .from(cadences)
        .where(eq(cadences.id, enr.cadenceId))
        .limit(1),
    )
    const waitHours = cad?.funnelAutomation ? Math.max(0, cad.loseAfterHours ?? 0) : 0
    if (waitHours > 0) {
      if (!enr.loseAt) {
        const loseAt = new Date(Date.now() + waitHours * 3_600_000).toISOString()
        await db
          .update(cadenceEnrollments)
          .set({ loseAt, updatedAt: new Date().toISOString() })
          .where(eq(cadenceEnrollments.id, enrollmentId))
        await recordCadenceEvent(accountId, enr, 'awaiting_loss', { data: { loseAt, hours: waitHours } })
      }
      return
    }
    await db
      .update(cadenceEnrollments)
      .set({ status: 'done', updatedAt: new Date().toISOString() })
      .where(eq(cadenceEnrollments.id, enrollmentId))
    await recordCadenceEvent(accountId, enr, 'completed', {
      data: { reason: 'sem degraus pendentes' },
    })
    // 🔁 Chegou aqui = ATIVA drenou todos os toques SEM o lead responder (uma
    // resposta teria PAUSADO, saindo deste caminho). Automação de funil: perde
    // + fecha a conversa.
    await onCadenceCompletedWithoutReply(accountId, {
      cadenceId: enr.cadenceId,
      dealId: enr.dealId,
      conversationId: enr.conversationId,
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
      // O card anda junto com o toque (ex.: Zelo — 2ª tentativa, 3ª…,
      // Definição). Só pra frente e só no funil dele (moveDealForward).
      if (enr.dealId && stepPosition != null) {
        const step = firstOrNull(
          await db
            .select({ moveToStageId: cadenceSteps.moveToStageId })
            .from(cadenceSteps)
            .where(and(eq(cadenceSteps.cadenceId, enr.cadenceId), eq(cadenceSteps.position, stepPosition)))
            .limit(1),
        )
        if (step?.moveToStageId) await moveDealForward(accountId, null, enr.dealId, step.moveToStageId)
      }
    }
    await finalizeEnrollmentIfDrained(accountId, enrollmentId)
  } catch (err) {
    console.error('[cadence] onCadenceStepSent:', err)
  }
}

/**
 * Antes de ENVIAR um degrau de cadência que ANDA O CARD pelas etapas (tem
 * "mover o card para" em algum toque — ex.: pré-vendas da Zelo): o card
 * fechou (o Renato ligou e fechou, a Zélia marcou reunião), foi pra outro
 * funil (alguém arrastou no RD) ou o time o levou ALÉM da etapa mais avançada
 * da cadência? Então cancela a inscrição e o toque NÃO sai (`cadenceStopReason`).
 *
 * Cadência que não anda o card fica como sempre foi — inclusive a de
 * pós-venda/recuperação, que ENTRA com o card já ganho/perdido (gatilho de
 * status da conta) e não pode ser cancelada por isso.
 * Best-effort: erro aqui deixa enviar (fail-open, como antes).
 */
export async function checkCadenceStepStillWanted(
  accountId: string,
  enrollmentId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
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
        .where(and(eq(cadenceEnrollments.id, enrollmentId), eq(cadenceEnrollments.accountId, accountId)))
        .limit(1),
    )
    if (!enr) return { ok: false, reason: 'inscrição não existe mais' }
    if (enr.status !== 'active') return { ok: false, reason: `inscrição ${enr.status}` }
    if (!enr.dealId) return { ok: true }

    // Etapas pra onde os toques movem o card (funil + posição).
    const cadenceStages = await db
      .select({ pipelineId: pipelineStages.pipelineId, position: pipelineStages.position })
      .from(cadenceSteps)
      .innerJoin(pipelineStages, eq(pipelineStages.id, cadenceSteps.moveToStageId))
      .where(and(eq(cadenceSteps.cadenceId, enr.cadenceId), isNotNull(cadenceSteps.moveToStageId)))
    if (!cadenceStages.length) return { ok: true } // não anda o card: comportamento de sempre

    const deal = firstOrNull(
      await db
        .select({ status: deals.status, pipelineId: deals.pipelineId, stagePosition: pipelineStages.position })
        .from(deals)
        .innerJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
        .where(and(eq(deals.id, enr.dealId), eq(deals.accountId, accountId)))
        .limit(1),
    )
    const reason = cadenceStopReason({
      deal: deal ? { status: deal.status ?? 'open', pipelineId: deal.pipelineId, stagePosition: deal.stagePosition } : null,
      cadenceStages,
    })
    if (!reason) return { ok: true }
    await endEnrollment(accountId, enr, 'cancelled', reason)
    return { ok: false, reason }
  } catch (err) {
    console.error('[cadence] checkCadenceStepStillWanted:', err)
    return { ok: true }
  }
}

/**
 * Perdas que VENCERAM: inscrição ativa com `lose_at` no passado (todos os
 * toques saíram, o lead não respondeu e a espera acabou) → conclui e marca o
 * card perdido com o motivo da cadência. Roda no worker (tick).
 */
export async function runCadenceLossSweep(limit = 50): Promise<{ lost: number }> {
  let lost = 0
  const due = await db
    .select({
      id: cadenceEnrollments.id,
      accountId: cadenceEnrollments.accountId,
      cadenceId: cadenceEnrollments.cadenceId,
      contactId: cadenceEnrollments.contactId,
      dealId: cadenceEnrollments.dealId,
      conversationId: cadenceEnrollments.conversationId,
    })
    .from(cadenceEnrollments)
    .where(
      and(
        eq(cadenceEnrollments.status, 'active'),
        isNotNull(cadenceEnrollments.loseAt),
        lte(cadenceEnrollments.loseAt, sql`now()`),
      ),
    )
    .orderBy(asc(cadenceEnrollments.loseAt))
    .limit(limit)
  for (const enr of due) {
    try {
      // Só quem AINDA está ativa (uma resposta de última hora pausou → sai).
      const closed = await db
        .update(cadenceEnrollments)
        .set({ status: 'done', updatedAt: new Date().toISOString() })
        .where(and(eq(cadenceEnrollments.id, enr.id), eq(cadenceEnrollments.status, 'active')))
        .returning({ id: cadenceEnrollments.id })
      if (!closed.length) continue
      await recordCadenceEvent(enr.accountId, enr, 'completed', {
        data: { reason: 'sem resposta até o fim da espera' },
      })
      await onCadenceCompletedWithoutReply(enr.accountId, {
        cadenceId: enr.cadenceId,
        dealId: enr.dealId,
        conversationId: enr.conversationId,
      })
      lost += 1
    } catch (err) {
      console.error('[cadence] perda vencida falhou:', err)
    }
  }
  return { lost }
}
