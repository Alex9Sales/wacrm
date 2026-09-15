'use server'

// ============================================================
// Server actions for the Broadcasts pages (list / new / detail).
// Replaces the Supabase browser-client queries these client pages
// used pre-Drizzle. Every query is scoped to the caller's account —
// there is no RLS anymore.
// ============================================================

import { and, count, desc, eq, ilike, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  db,
  broadcasts,
  broadcastRecipients,
  contacts,
  contactTags,
  conversations,
  customFields,
  contactCustomValues,
  messageTemplates,
} from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import {
  ForbiddenError,
  getCurrentAccount,
  requireRole,
  type AccountContext,
} from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { channels, user } from '@/db'
import {
  pauseBroadcast,
  resumeBroadcast,
  cancelBroadcast,
  retryFailedBroadcast,
  deleteOrArchiveBroadcast,
  type ControlResult,
} from '@/lib/queue/broadcast-controls'
import { loadChannel, loadDefaultChannel } from '@/lib/channels/channels'
import { resolveOrCreateContactIdsByPhone } from '@/lib/contacts/dedupe'
import { getProvider } from '@/lib/channels/registry'
import type { ProviderId } from '@/lib/channels/provider'
import { rescheduleRecipient } from '@/lib/queue/queues'
import {
  inferSpacingMs,
  normalizePacing,
  pacingIntervalMinutes,
  type PacingConfig,
} from '@/lib/whatsapp/drip-schedule'
import {
  enqueueTextBroadcast,
  type EnqueueTextBroadcastResult,
} from '@/lib/broadcasts/text-broadcast'
import { otherPersonNumberError } from '@/lib/broadcasts/channel-owner-guard'
import { logBroadcastEvent, type BroadcastAuditAction } from '@/lib/broadcasts/audit'
import { removePendingRecipient } from '@/lib/broadcasts/recipient-remove'
import { canManageBroadcast } from '@/lib/broadcasts/detail-text'
import { broadcastDeleteOrArchive } from '@/lib/broadcasts/deletion-rule'
import { ALREADY_RECEIVED_ELSEWHERE_ERROR } from '@/lib/broadcasts/duplicate-sends'
import {
  agentCanReadRow,
  getAdminUserIds,
  getDedicatedChannelMap,
  getParticipantConversationIdsBySource,
  getUserSectorIds,
  teamSeesAll,
} from '@/lib/sectors/access'
import type {
  Broadcast,
  BroadcastRecipient,
  Contact,
  CustomField,
  MessageTemplate,
} from '@/types'

// Snake_case projection matching the old PostgREST `select('*')` shape.
const broadcastColumns = {
  id: broadcasts.id,
  user_id: broadcasts.userId,
  account_id: broadcasts.accountId,
  name: broadcasts.name,
  template_name: broadcasts.templateName,
  template_language: broadcasts.templateLanguage,
  template_variables: broadcasts.templateVariables,
  message_kind: broadcasts.messageKind,
  pacing: broadcasts.pacing,
  audience_filter: broadcasts.audienceFilter,
  channel_id: broadcasts.channelId,
  channel_name: channels.name,
  scheduled_at: broadcasts.scheduledAt,
  status: broadcasts.status,
  total_recipients: broadcasts.totalRecipients,
  sent_count: broadcasts.sentCount,
  delivered_count: broadcasts.deliveredCount,
  read_count: broadcasts.readCount,
  replied_count: broadcasts.repliedCount,
  failed_count: broadcasts.failedCount,
  created_at: broadcasts.createdAt,
  updated_at: broadcasts.updatedAt,
}

const contactColumns = {
  id: contacts.id,
  user_id: contacts.userId,
  account_id: contacts.accountId,
  phone: contacts.phone,
  phone_normalized: contacts.phoneNormalized,
  name: contacts.name,
  email: contacts.email,
  company: contacts.company,
  avatar_url: contacts.avatarUrl,
  created_at: contacts.createdAt,
  updated_at: contacts.updatedAt,
}

/**
 * Newest-first list of the account's broadcasts. Arquivados (15/09) ficam
 * de fora por padrão; `archived: true` lista só eles (filtro "Arquivados").
 */
export async function listBroadcasts(
  opts: { archived?: boolean } = {},
): Promise<Broadcast[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({ ...broadcastColumns, archived_at: broadcasts.archivedAt })
    .from(broadcasts)
    .leftJoin(channels, eq(channels.id, broadcasts.channelId))
    .where(
      and(
        eq(broadcasts.accountId, ctx.accountId),
        opts.archived ? isNotNull(broadcasts.archivedAt) : isNull(broadcasts.archivedAt),
      ),
    )
    .orderBy(desc(broadcasts.createdAt))
  return rows as unknown as Broadcast[]
}

/** Timestamp do pg ("2026-09-15 13:30:00+00" ou Date) → ISO; inválido → null. */
function isoOrNull(v: unknown): string | null {
  if (v == null) return null
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v))
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

// Pessoas citadas na tela do disparo (15/09 GoLink): dono do número, quem
// criou, quem pausou, quem arquivou.
const channelOwnerUser = alias(user, 'bc_channel_owner')
const creatorUser = alias(user, 'bc_creator')
const pausedByUser = alias(user, 'bc_paused_by')
const archivedByUser = alias(user, 'bc_archived_by')

/**
 * One broadcast (account-scoped) or null — com o que a tela precisa pra dizer
 * quando sai o próximo, quem pausou e por qual número (15/09, GoLink: a tela
 * dizia só "Pausado" e ninguém sabia de quem era o número).
 */
export async function getBroadcast(broadcastId: string): Promise<Broadcast | null> {
  const ctx = await getCurrentAccount()
  const row = firstOrNull(
    await db
      .select({
        ...broadcastColumns,
        channel_owner_name: channelOwnerUser.name,
        created_by_name: creatorUser.name,
        paused_by_name: pausedByUser.name,
        paused_at: broadcasts.pausedAt,
        pause_reason: broadcasts.pauseReason,
        archived_at: broadcasts.archivedAt,
        archived_by_name: archivedByUser.name,
      })
      .from(broadcasts)
      .leftJoin(channels, eq(channels.id, broadcasts.channelId))
      .leftJoin(channelOwnerUser, eq(channelOwnerUser.id, channels.dedicatedUserId))
      .leftJoin(creatorUser, eq(creatorUser.id, broadcasts.userId))
      .leftJoin(pausedByUser, eq(pausedByUser.id, broadcasts.pausedBy))
      .leftJoin(archivedByUser, eq(archivedByUser.id, broadcasts.archivedBy))
      .where(and(eq(broadcasts.id, broadcastId), eq(broadcasts.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!row) return null

  // Fila: quantos faltam e a janela de horários gravados dos pendentes.
  const agg = firstOrNull(
    await db
      .select({
        pending: sql<number>`count(*) FILTER (WHERE ${broadcastRecipients.status} = 'pending')::int`,
        processed: sql<number>`count(*) FILTER (WHERE ${broadcastRecipients.status} <> 'pending')::int`,
        attempted: sql<number>`count(*) FILTER (WHERE ${broadcastRecipients.attempts} > 0)::int`,
        skippedElsewhere: sql<number>`count(*) FILTER (WHERE ${broadcastRecipients.status} = 'failed' AND ${broadcastRecipients.errorMessage} = ${ALREADY_RECEIVED_ELSEWHERE_ERROR})::int`,
        nextSlot: sql<string | null>`min(${broadcastRecipients.scheduledSlotAt}) FILTER (WHERE ${broadcastRecipients.status} = 'pending')`,
        lastSlot: sql<string | null>`max(${broadcastRecipients.scheduledSlotAt}) FILTER (WHERE ${broadcastRecipients.status} = 'pending')`,
      })
      .from(broadcastRecipients)
      .where(eq(broadcastRecipients.broadcastId, broadcastId)),
  )
  const pendingCount = agg?.pending ?? 0

  // Ritmo: gotejamento = janela ÷ máx/dia; senão deduzido dos horários
  // gravados (mesma regra do retomar). Só os próximos 200 bastam pra mediana.
  let intervalMs = 0
  if (row.pacing) {
    intervalMs = pacingIntervalMinutes(normalizePacing(row.pacing as Partial<PacingConfig>)) * 60_000
  } else if (pendingCount > 0 && agg?.nextSlot) {
    let slots = await db
      .select({ at: broadcastRecipients.scheduledSlotAt })
      .from(broadcastRecipients)
      .where(
        and(
          eq(broadcastRecipients.broadcastId, broadcastId),
          eq(broadcastRecipients.status, 'pending'),
          isNotNull(broadcastRecipients.scheduledSlotAt),
        ),
      )
      .orderBy(broadcastRecipients.scheduledSlotAt)
      .limit(200)
    if (slots.length < 2) {
      slots = await db
        .select({ at: broadcastRecipients.scheduledSlotAt })
        .from(broadcastRecipients)
        .where(
          and(eq(broadcastRecipients.broadcastId, broadcastId), isNotNull(broadcastRecipients.scheduledSlotAt)),
        )
        .orderBy(desc(broadcastRecipients.scheduledSlotAt))
        .limit(200)
    }
    intervalMs = inferSpacingMs(slots.map((s) => (s.at ? Date.parse(s.at) : null)))
  }

  return {
    ...row,
    paused_at: isoOrNull(row.paused_at),
    archived_at: isoOrNull(row.archived_at),
    pending_count: pendingCount,
    processed_count: agg?.processed ?? 0,
    next_slot_at: isoOrNull(agg?.nextSlot),
    last_slot_at: isoOrNull(agg?.lastSlot),
    interval_ms: intervalMs,
    skipped_elsewhere_count: agg?.skippedElsewhere ?? 0,
    // Mesma regra de deleteOrArchiveBroadcast (sem olhar a fila: um job ativo
    // só pode transformar "apagar" em "arquivar", nunca o contrário).
    delete_mode: broadcastDeleteOrArchive({
      previousStatus: row.status,
      sentCount: row.sent_count,
      nonPendingCount: agg?.processed ?? 0,
      attemptedCount: agg?.attempted ?? 0,
      activeJob: false,
    }),
    can_delete: canManageBroadcast({
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      creatorUserId: row.user_id,
    }),
  } as unknown as Broadcast
}

/**
 * Recipients of a broadcast with the contact embedded, newest first.
 * Mirrors the old `select('*, contact:contacts(*)')` shape.
 */
export async function listBroadcastRecipients(
  broadcastId: string,
): Promise<BroadcastRecipient[]> {
  const ctx = await getCurrentAccount()

  // Scope through the parent broadcast — recipients have no account_id.
  const parent = firstOrNull(
    await db
      .select({ id: broadcasts.id, channelId: broadcasts.channelId })
      .from(broadcasts)
      .where(and(eq(broadcasts.id, broadcastId), eq(broadcasts.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!parent) return []

  const rows = await db
    .select({
      id: broadcastRecipients.id,
      broadcast_id: broadcastRecipients.broadcastId,
      contact_id: broadcastRecipients.contactId,
      status: broadcastRecipients.status,
      whatsapp_message_id: broadcastRecipients.whatsappMessageId,
      sent_at: broadcastRecipients.sentAt,
      delivered_at: broadcastRecipients.deliveredAt,
      read_at: broadcastRecipients.readAt,
      replied_at: broadcastRecipients.repliedAt,
      error_message: broadcastRecipients.errorMessage,
      created_at: broadcastRecipients.createdAt,
      contact: contactColumns,
    })
    .from(broadcastRecipients)
    .leftJoin(contacts, eq(broadcastRecipients.contactId, contacts.id))
    .where(eq(broadcastRecipients.broadcastId, broadcastId))
    .orderBy(desc(broadcastRecipients.createdAt))

  // 15/09 (GoLink, Vitor): o "Chat" caía na conversa do contato em QUALQUER
  // número (a mais recente) e, quando era a do número do Leonardo, a caixa
  // dizia só "não disponível". Agora: só a conversa no número do disparo
  // (disparo antigo sem canal gravado = o padrão da conta, igual ao worker),
  // pendente não tem link, e cada linha diz se quem olha consegue abrir.
  const channelId =
    parent.channelId ?? (await loadDefaultChannel(ctx.accountId))?.id ?? null
  const contactIds = [
    ...new Set(
      rows
        .filter((r) => r.status !== 'pending')
        .map((r) => r.contact_id)
        .filter((id): id is string => !!id),
    ),
  ]
  const convByContact = new Map<string, RecipientConversation>()
  if (channelId && contactIds.length > 0) {
    const assigneeUser = alias(user, 'rc_assignee')
    const ownerUser = alias(user, 'rc_channel_owner')
    const convRows = await db
      .select({
        id: conversations.id,
        contactId: conversations.contactId,
        channelId: conversations.channelId,
        sectorId: conversations.sectorId,
        assignedAgentId: conversations.assignedAgentId,
        isPrivate: conversations.isPrivate,
        channelName: channels.name,
        channelOwnerId: channels.dedicatedUserId,
        channelOwnerName: ownerUser.name,
        assigneeName: assigneeUser.name,
      })
      .from(conversations)
      .leftJoin(channels, eq(channels.id, conversations.channelId))
      .leftJoin(ownerUser, eq(ownerUser.id, channels.dedicatedUserId))
      .leftJoin(assigneeUser, eq(assigneeUser.id, conversations.assignedAgentId))
      .where(
        and(
          eq(conversations.accountId, ctx.accountId),
          eq(conversations.channelId, channelId),
          inArray(conversations.contactId, contactIds),
        ),
      )
      // ⚠️ DESC põe NULL primeiro: conversa sem mensagem vale pela criação.
      .orderBy(sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt}) DESC`)
    for (const c of convRows) {
      if (c.contactId && !convByContact.has(c.contactId)) convByContact.set(c.contactId, c)
    }
  }
  const canRead = await recipientConversationReader(ctx, [...convByContact.values()])

  return rows.map((r) => {
    const conv = r.status !== 'pending' && r.contact_id ? convByContact.get(r.contact_id) : undefined
    const readable = conv ? canRead(conv) : false
    return {
      ...r,
      conversation_id: conv?.id ?? null,
      conversation_readable: readable,
      conversation_channel_name: conv?.channelName ?? null,
      // Com quem está (só pra dica do cadeado): dono do número dedicado,
      // senão quem atende — nunca o nome de admin ("ninguém vê as do admin").
      conversation_holder_name:
        conv && !readable ? conv.holderName : null,
      contact: r.contact?.id ? (r.contact as unknown as Contact) : undefined,
    }
  }) as unknown as BroadcastRecipient[]
}

interface RecipientConversation {
  id: string
  contactId: string | null
  channelId: string | null
  sectorId: string | null
  assignedAgentId: string | null
  isPrivate: boolean
  channelName: string | null
  channelOwnerId: string | null
  channelOwnerName: string | null
  assigneeName: string | null
  holderName?: string | null
}

/**
 * Leitura (abrir a conversa) com os conjuntos carregados UMA vez — espelha
 * canReadConversation (lib/sectors/access.ts), como a lista da caixa faz.
 * Também preenche `holderName` de cada conversa pra dica do cadeado.
 */
async function recipientConversationReader(
  ctx: AccountContext,
  convs: RecipientConversation[],
): Promise<(c: RecipientConversation) => boolean> {
  const needsAdmins = convs.some((c) => c.assignedAgentId)
  const isAdmin = hasMinRole(ctx.role, 'admin')
  const isSupervisor = hasMinRole(ctx.role, 'supervisor')
  const isAgentTier = !isSupervisor
  const noParticipation = { mention: [] as string[], broadcast: [] as string[] }
  const [adminIdsArr, sectorIdsArr, participation, dedicatedByChannel, openTeam] =
    convs.length === 0 || isAdmin
      ? [[] as string[], [] as string[], noParticipation, new Map<string, string>(), false]
      : await Promise.all([
          needsAdmins ? getAdminUserIds(ctx.accountId) : Promise.resolve([] as string[]),
          isAgentTier ? getUserSectorIds(ctx.userId) : Promise.resolve([] as string[]),
          isAgentTier ? getParticipantConversationIdsBySource(ctx.userId) : Promise.resolve(noParticipation),
          isAgentTier ? getDedicatedChannelMap(ctx.accountId) : Promise.resolve(new Map<string, string>()),
          teamSeesAll(ctx.accountId),
        ])
  const adminIds = new Set(adminIdsArr)
  const sectorIds = new Set(sectorIdsArr)
  const participantIds = new Set(participation.mention)
  const broadcastParticipantIds = new Set(participation.broadcast)

  for (const c of convs) {
    const assigneeIsAdmin = !!c.assignedAgentId && adminIds.has(c.assignedAgentId)
    c.holderName =
      (c.channelOwnerId ? c.channelOwnerName : null) ??
      (c.assignedAgentId && !assigneeIsAdmin ? c.assigneeName : null)
  }

  return (c) => {
    if (isAdmin) return true
    if (c.assignedAgentId && c.assignedAgentId === ctx.userId) return true
    if (openTeam) return !c.isPrivate || isSupervisor
    if (isSupervisor) return !(c.assignedAgentId && adminIds.has(c.assignedAgentId))
    return agentCanReadRow({
      userId: ctx.userId,
      conversationId: c.id,
      sectorId: c.sectorId,
      assignedAgentId: c.assignedAgentId,
      isPrivate: c.isPrivate,
      sectorIds,
      adminIds,
      participantIds,
      broadcastParticipantIds,
      channelId: c.channelId,
      dedicatedByChannel,
    })
  }
}

/**
 * Quem fez a ação, pro rastro (lib/broadcasts/audit.ts → broadcast_events).
 * Nunca lança (o rastro é best-effort); aguardado pra gravar antes de a
 * resposta sair (revisão 15/09: só no console sumia a cada deploy).
 */
async function audit(
  ctx: AccountContext,
  action: BroadcastAuditAction,
  broadcastId: string,
  more: {
    channelId?: string | null
    sentCount?: number | null
    previousStatus?: string | null
    extra?: Record<string, unknown>
  } = {},
): Promise<void> {
  await logBroadcastEvent({
    action,
    broadcastId,
    accountId: ctx.accountId,
    userId: ctx.userId,
    role: ctx.role,
    ...more,
  })
}

/** Canal e quantos já saíram — contexto da linha de auditoria. */
async function auditSnapshot(
  broadcastId: string,
  accountId: string,
): Promise<{ channelId: string | null; sentCount: number | null }> {
  try {
    const row = firstOrNull(
      await db
        .select({ channelId: broadcasts.channelId, sentCount: broadcasts.sentCount })
        .from(broadcasts)
        .where(and(eq(broadcasts.id, broadcastId), eq(broadcasts.accountId, accountId)))
        .limit(1),
    )
    return { channelId: row?.channelId ?? null, sentCount: row?.sentCount ?? null }
  } catch {
    return { channelId: null, sentCount: null }
  }
}

/**
 * "Excluir" (15/09, GoLink): quem criou ou supervisor+. Disparo que já saiu
 * pra alguém é ARQUIVADO (some da lista, o histórico de quem recebeu fica);
 * ativo é cancelado antes. Nunca saiu → apaga. Regra em
 * deleteOrArchiveBroadcast (lib/queue/broadcast-controls.ts), a mesma da API.
 */
export async function deleteBroadcast(
  broadcastId: string,
): Promise<{ ok: boolean; archived?: boolean; error?: string }> {
  try {
    const ctx = await getCurrentAccount()
    // O rastro (delete/archive) é gravado lá dentro: a exclusão real grava o
    // evento ANTES de apagar, na mesma transação.
    const result = await deleteOrArchiveBroadcast(broadcastId, ctx.accountId, {
      userId: ctx.userId,
      role: ctx.role,
    })
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, archived: result.archived }
  } catch (err) {
    console.error('[broadcast] deleteBroadcast failed:', err)
    return { ok: false, error: 'Não foi possível excluir o disparo. Tente de novo.' }
  }
}

/**
 * "Tirar da fila" (15/09, GoLink): tira UMA pessoa que ainda não recebeu,
 * sem cancelar e refazer o disparo inteiro (o que gerou envios repetidos).
 */
export async function removeBroadcastRecipientAction(
  broadcastId: string,
  recipientId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const ctx = await requireRole('agent')
    const archived = firstOrNull(
      await db
        .select({ archivedAt: broadcasts.archivedAt })
        .from(broadcasts)
        .where(and(eq(broadcasts.id, broadcastId), eq(broadcasts.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!archived) return { ok: false, error: 'Disparo não encontrado.' }
    if (archived.archivedAt) return { ok: false, error: 'Este disparo está arquivado.' }
    const result = await removePendingRecipient(ctx.accountId, broadcastId, recipientId)
    if (!result.ok) return result
    const snap = await auditSnapshot(broadcastId, ctx.accountId)
    await audit(ctx, 'remove_recipient', broadcastId, { ...snap, extra: { recipientId } })
    return { ok: true }
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return { ok: false, error: 'Seu acesso é só de leitura: peça a quem criou o disparo pra tirar da fila.' }
    }
    console.error('[broadcast] removeBroadcastRecipientAction failed:', err)
    return { ok: false, error: 'Não foi possível tirar essa pessoa da fila. Tente de novo.' }
  }
}

export interface SaveDraftInput {
  name: string
  template_name: string
  template_language: string
  template_variables: Record<string, unknown>
  audience_filter: Record<string, unknown>
}

/** Persist a draft broadcast row — no recipients, no sending. */
export async function saveDraftBroadcast(
  input: SaveDraftInput,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db.insert(broadcasts).values({
      userId: ctx.userId,
      accountId: ctx.accountId,
      name: input.name,
          // Assistente de template: sem filtro de repetidos no worker (como antes).
          allowRepeats: true,
      templateName: input.template_name,
      templateLanguage: input.template_language,
      templateVariables: input.template_variables,
      audienceFilter: input.audience_filter,
      status: 'draft',
      totalRecipients: 0,
      sentCount: 0,
      deliveredCount: 0,
      readCount: 0,
      repliedCount: 0,
      failedCount: 0,
    })
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to save draft' }
  }
}

// ============================================================
// Broadcast wizard support actions (step1-4 + send hook).
// These replace the browser-supabase reads the wizard used
// pre-Drizzle. Every query is scoped to the caller's account.
// ============================================================

/**
 * APPROVED templates only, newest first. Backs the step-1 template
 * picker, which previously read `message_templates` directly with a
 * `status = 'APPROVED'` filter. Only APPROVED templates can be sent via
 * Meta — anything else 400s at broadcast time.
 */
export async function listApprovedTemplates(): Promise<MessageTemplate[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: messageTemplates.id,
      user_id: messageTemplates.userId,
      account_id: messageTemplates.accountId,
      name: messageTemplates.name,
      category: messageTemplates.category,
      language: messageTemplates.language,
      header_type: messageTemplates.headerType,
      header_content: messageTemplates.headerContent,
      header_handle: messageTemplates.headerHandle,
      header_media_url: messageTemplates.headerMediaUrl,
      body_text: messageTemplates.bodyText,
      footer_text: messageTemplates.footerText,
      buttons: messageTemplates.buttons,
      sample_values: messageTemplates.sampleValues,
      status: messageTemplates.status,
      meta_template_id: messageTemplates.metaTemplateId,
      rejection_reason: messageTemplates.rejectionReason,
      quality_score: messageTemplates.qualityScore,
      submission_error: messageTemplates.submissionError,
      last_submitted_at: messageTemplates.lastSubmittedAt,
      created_at: messageTemplates.createdAt,
    })
    .from(messageTemplates)
    .where(
      and(
        eq(messageTemplates.accountId, ctx.accountId),
        eq(messageTemplates.status, 'APPROVED'),
      ),
    )
    .orderBy(desc(messageTemplates.createdAt))
  return rows as unknown as MessageTemplate[]
}

export interface BroadcastChannel {
  id: string
  name: string
  phone_number: string | null
  status: string
  /** Canal de e-mail (email/gmail) — disparo vira newsletter com assunto. */
  is_email?: boolean
  /** Dono do número (canal dedicado). null = número da empresa. 15/09 GoLink. */
  dedicated_user_id?: string | null
  dedicated_user_name?: string | null
}

/**
 * The account's Meta (WhatsApp Cloud) channels — the only providers a
 * template broadcast can go out on. Backs the step-4 channel picker. When
 * the account has exactly one, the wizard defaults it silently; with more
 * than one the user must pick which number to send from.
 */
export async function listMetaChannels(): Promise<BroadcastChannel[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: channels.id,
      name: channels.name,
      phone_number: channels.phoneNumber,
      status: channels.status,
      dedicated_user_id: channels.dedicatedUserId,
      dedicated_user_name: user.name,
    })
    .from(channels)
    .leftJoin(user, eq(user.id, channels.dedicatedUserId))
    .where(
      and(eq(channels.accountId, ctx.accountId), eq(channels.provider, 'meta')),
    )
    .orderBy(channels.name)
  return rows as BroadcastChannel[]
}

/** The account's custom fields, ordered by name (step-2 / step-3). */
export async function listCustomFields(): Promise<CustomField[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: customFields.id,
      user_id: customFields.userId,
      account_id: customFields.accountId,
      field_name: customFields.fieldName,
      field_type: customFields.fieldType,
      field_options: customFields.fieldOptions,
      created_at: customFields.createdAt,
    })
    .from(customFields)
    // Disparo personaliza CONTATOS → só campos de contato (não os de negócio).
    .where(and(eq(customFields.accountId, ctx.accountId), eq(customFields.entity, 'contact')))
    .orderBy(customFields.fieldName)
  return rows as unknown as CustomField[]
}

export type AudienceCountType = 'all' | 'tags' | 'custom_field' | 'csv' | 'contacts'
export type CustomFieldOperator = 'is' | 'is_not' | 'contains'

export interface AudienceCountInput {
  type: AudienceCountType
  tagIds?: string[]
  customField?: {
    fieldId: string
    operator: CustomFieldOperator
    value: string
  }
  /** For CSV the caller already knows the count — passed through as-is. */
  csvCount?: number
  /** Explicitly picked contact ids (type 'contacts'). */
  contactIds?: string[]
  excludeTagIds?: string[]
}

/**
 * Live recipient-count estimate for the audience wizard (step-2 summary
 * and step-4 review). Mirrors the old browser logic: resolve the base
 * contact-id set for the audience type, subtract any exclude-tag
 * contacts, and count. All account-scoped.
 *
 * Returns null for partially-configured audiences (e.g. a tag filter
 * with no tags picked) so the UI can show "Select an audience type".
 */
export async function estimateAudienceCount(
  input: AudienceCountInput,
): Promise<number | null> {
  const ctx = await getCurrentAccount()

  // Resolve the set of contacts carrying any exclude tag, scoped to the
  // account. Shared across the branches below.
  async function resolveExcludeIds(): Promise<Set<string>> {
    if (!input.excludeTagIds || input.excludeTagIds.length === 0)
      return new Set()
    const rows = await db
      .select({ contact_id: contactTags.contactId })
      .from(contactTags)
      .innerJoin(contacts, eq(contactTags.contactId, contacts.id))
      .where(
        and(
          inArray(contactTags.tagId, input.excludeTagIds),
          eq(contacts.accountId, ctx.accountId),
        ),
      )
    return new Set(rows.map((r) => r.contact_id))
  }

  if (input.type === 'csv') {
    return input.csvCount ?? 0
  }

  if (input.type === 'contacts') {
    return input.contactIds?.length ?? 0
  }

  if (input.type === 'all') {
    const excludeSet = await resolveExcludeIds()
    const total = firstOrThrow(
      await db
        .select({ n: count() })
        .from(contacts)
        .where(eq(contacts.accountId, ctx.accountId)),
    ).n
    return excludeSet.size ? Math.max(0, total - excludeSet.size) : total
  }

  let baseIds: Set<string>
  if (input.type === 'tags') {
    if (!input.tagIds || input.tagIds.length === 0) return null
    const rows = await db
      .select({ contact_id: contactTags.contactId })
      .from(contactTags)
      .innerJoin(contacts, eq(contactTags.contactId, contacts.id))
      .where(
        and(
          inArray(contactTags.tagId, input.tagIds),
          eq(contacts.accountId, ctx.accountId),
        ),
      )
    baseIds = new Set(rows.map((r) => r.contact_id))
  } else {
    // custom_field
    const cf = input.customField
    if (!cf?.fieldId || !cf.value) return null
    const rows = await db
      .select({ contact_id: contactCustomValues.contactId })
      .from(contactCustomValues)
      .innerJoin(contacts, eq(contactCustomValues.contactId, contacts.id))
      .where(
        and(
          eq(contactCustomValues.customFieldId, cf.fieldId),
          eq(contacts.accountId, ctx.accountId),
          cf.operator === 'is'
            ? eq(contactCustomValues.value, cf.value)
            : cf.operator === 'is_not'
              ? ne(contactCustomValues.value, cf.value)
              : ilike(contactCustomValues.value, `%${cf.value}%`),
        ),
      )
    baseIds = new Set(rows.map((r) => r.contact_id))
  }

  const excludeSet = await resolveExcludeIds()
  let n = 0
  for (const id of baseIds) if (!excludeSet.has(id)) n++
  return n
}

/**
 * A single representative contact (newest) plus its custom-field values,
 * for the step-3 live preview. Returns null contact when the account has
 * no contacts yet (the UI falls back to sample data).
 */
export async function getPreviewContact(): Promise<{
  contact: Contact | null
  customValues: { custom_field_id: string; value: string }[]
}> {
  const ctx = await getCurrentAccount()
  const contact = firstOrNull(
    await db
      .select(contactColumns)
      .from(contacts)
      .where(eq(contacts.accountId, ctx.accountId))
      .orderBy(desc(contacts.createdAt))
      .limit(1),
  ) as unknown as Contact | null

  if (!contact) return { contact: null, customValues: [] }

  const customValues = await db
    .select({
      custom_field_id: contactCustomValues.customFieldId,
      value: sql<string>`coalesce(${contactCustomValues.value}, '')`,
    })
    .from(contactCustomValues)
    .where(eq(contactCustomValues.contactId, contact.id))

  return { contact, customValues }
}

// ------------------------------------------------------------
// Send-hook data actions (use-broadcast-sending.ts).
// The hook can't touch @/db (pg is Node-only), so audience
// resolution, CSV contact upsert, custom-value preload, and the
// broadcast/recipient row writes all live here. The actual Meta
// send still goes through POST /api/whatsapp/broadcast.
// ------------------------------------------------------------

export interface ResolveAudienceInput {
  type: AudienceCountType
  tagIds?: string[]
  customField?: {
    fieldId: string
    operator: CustomFieldOperator
    value: string
  }
  csvContacts?: { phone: string; name?: string }[]
  /** Explicitly picked contact ids (type 'contacts'). */
  contactIds?: string[]
  excludeTagIds?: string[]
}

/**
 * Resolve the full contact list for an audience config, applying the
 * exclude-tag subtraction. CSV audiences upsert missing contacts first
 * so every returned contact has a real contacts.id (recipients FK it).
 * Account-scoped throughout.
 */
export async function resolveAudienceContacts(
  input: ResolveAudienceInput,
): Promise<Contact[]> {
  const ctx = await getCurrentAccount()

  let rows: Contact[] = []

  if (input.type === 'all') {
    rows = (await db
      .select(contactColumns)
      .from(contacts)
      .where(eq(contacts.accountId, ctx.accountId))) as unknown as Contact[]
  } else if (input.type === 'tags' && input.tagIds && input.tagIds.length > 0) {
    const idRows = await db
      .selectDistinct({ contact_id: contactTags.contactId })
      .from(contactTags)
      .innerJoin(contacts, eq(contactTags.contactId, contacts.id))
      .where(
        and(
          inArray(contactTags.tagId, input.tagIds),
          eq(contacts.accountId, ctx.accountId),
        ),
      )
    const ids = idRows.map((r) => r.contact_id)
    if (ids.length > 0) {
      rows = (await db
        .select(contactColumns)
        .from(contacts)
        .where(
          and(inArray(contacts.id, ids), eq(contacts.accountId, ctx.accountId)),
        )) as unknown as Contact[]
    }
  } else if (input.type === 'custom_field' && input.customField) {
    const cf = input.customField
    const matchRows = await db
      .selectDistinct({ contact_id: contactCustomValues.contactId })
      .from(contactCustomValues)
      .innerJoin(contacts, eq(contactCustomValues.contactId, contacts.id))
      .where(
        and(
          eq(contactCustomValues.customFieldId, cf.fieldId),
          eq(contacts.accountId, ctx.accountId),
          cf.operator === 'is'
            ? eq(contactCustomValues.value, cf.value)
            : cf.operator === 'is_not'
              ? ne(contactCustomValues.value, cf.value)
              : ilike(contactCustomValues.value, `%${cf.value}%`),
        ),
      )
    const ids = matchRows.map((r) => r.contact_id)
    if (ids.length > 0) {
      rows = (await db
        .select(contactColumns)
        .from(contacts)
        .where(
          and(inArray(contacts.id, ids), eq(contacts.accountId, ctx.accountId)),
        )) as unknown as Contact[]
    }
  } else if (input.type === 'csv' && input.csvContacts) {
    rows = await upsertCsvContacts(ctx.userId, ctx.accountId, input.csvContacts)
  } else if (
    input.type === 'contacts' &&
    input.contactIds &&
    input.contactIds.length > 0
  ) {
    rows = (await db
      .select(contactColumns)
      .from(contacts)
      .where(
        and(
          inArray(contacts.id, input.contactIds),
          eq(contacts.accountId, ctx.accountId),
        ),
      )) as unknown as Contact[]
  }

  // Exclude tags — works across every contact-derived audience type.
  // CSV contacts are real rows now, so exclusion applies to them too.
  if (input.excludeTagIds && input.excludeTagIds.length > 0 && rows.length > 0) {
    const exRows = await db
      .select({ contact_id: contactTags.contactId })
      .from(contactTags)
      .innerJoin(contacts, eq(contactTags.contactId, contacts.id))
      .where(
        and(
          inArray(contactTags.tagId, input.excludeTagIds),
          eq(contacts.accountId, ctx.accountId),
        ),
      )
    const excluded = new Set(exRows.map((r) => r.contact_id))
    rows = rows.filter((c) => !excluded.has(c.id))
  }

  return rows
}

/**
 * CSV uploads arrive as raw phone/name pairs. Look up each phone in the
 * account's contacts; insert any that don't exist; return the resolved
 * set in input order. Account/user-scoped — no session lookup needed
 * since the caller is derived via getCurrentAccount().
 */
async function upsertCsvContacts(
  userId: string,
  accountId: string,
  csvRows: { phone: string; name?: string }[],
): Promise<Contact[]> {
  if (csvRows.length === 0) return []

  // Resolve/create with the SHARED fuzzy dedup (last-8), so a Brazilian
  // 9th-digit / trunk variant maps to the existing contact instead of spawning
  // a duplicate. (Was: exact contacts.phone match → dup whenever the CSV used a
  // different format, e.g. "+55DDD9…" vs the webhook's "55DDD…".)
  const idByPhone = await resolveOrCreateContactIdsByPhone(
    accountId,
    userId,
    csvRows.map((r) => ({ phone: r.phone, name: r.name ?? null })),
  )
  const ids = [...new Set(idByPhone.values())]
  if (ids.length === 0) return []

  const rows = (await db
    .select(contactColumns)
    .from(contacts)
    .where(
      and(eq(contacts.accountId, accountId), inArray(contacts.id, ids)),
    )) as unknown as Contact[]
  const byId = new Map<string, Contact>()
  for (const c of rows) byId.set(c.id, c)

  // Preserve input order (first occurrence) so analytics roughly matches the CSV.
  const seen = new Set<string>()
  const out: Contact[] = []
  for (const r of csvRows) {
    const id = r.phone ? idByPhone.get(r.phone.trim()) : undefined
    if (!id || seen.has(id)) continue
    seen.add(id)
    const c = byId.get(id)
    if (c) out.push(c)
  }
  return out
}

/**
 * Bulk-fetch contact_custom_values for a set of contacts. Returns flat
 * rows the hook indexes into contactId → fieldId → value to avoid N+1
 * during the send loop. Scoped to the account through the contacts join.
 */
export async function listContactCustomValues(
  contactIds: string[],
): Promise<{ contact_id: string; custom_field_id: string; value: string }[]> {
  if (contactIds.length === 0) return []
  const ctx = await getCurrentAccount()
  return db
    .select({
      contact_id: contactCustomValues.contactId,
      custom_field_id: contactCustomValues.customFieldId,
      value: sql<string>`coalesce(${contactCustomValues.value}, '')`,
    })
    .from(contactCustomValues)
    .innerJoin(contacts, eq(contactCustomValues.contactId, contacts.id))
    .where(
      and(
        inArray(contactCustomValues.contactId, contactIds),
        eq(contacts.accountId, ctx.accountId),
      ),
    )
}

export interface CreateBroadcastInput {
  name: string
  template_name: string
  template_language: string
  template_variables: Record<string, unknown>
  audience_filter: Record<string, unknown>
  /** Resolved contact ids, in send order. */
  contactIds: string[]
}

/**
 * Create the `broadcasts` row (status 'sending') plus one
 * `broadcast_recipients` row per contact. Returns the new broadcast id.
 * Account-scoped; the recipient FK inherits scoping through the
 * broadcast. Replaces the browser-side inserts the hook used to do.
 */
export async function createBroadcastWithRecipients(
  input: CreateBroadcastInput,
): Promise<{ broadcastId: string | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    if (input.contactIds.length === 0) {
      return { broadcastId: null, error: 'No contacts found for this audience.' }
    }

    const broadcast = firstOrThrow(
      await db
        .insert(broadcasts)
        .values({
          userId: ctx.userId,
          accountId: ctx.accountId,
          name: input.name,
          // Assistente de template: sem filtro de repetidos no worker (como antes).
          allowRepeats: true,
          templateName: input.template_name,
          templateLanguage: input.template_language,
          templateVariables: input.template_variables,
          audienceFilter: input.audience_filter,
          status: 'sending',
          totalRecipients: input.contactIds.length,
          sentCount: 0,
          deliveredCount: 0,
          readCount: 0,
          repliedCount: 0,
          failedCount: 0,
        })
        .returning({ id: broadcasts.id }),
    )

    const recipientRows = input.contactIds.map((contactId) => ({
      broadcastId: broadcast.id,
      contactId,
      status: 'pending' as const,
    }))

    const INSERT_BATCH_SIZE = 200
    try {
      for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
        await db
          .insert(broadcastRecipients)
          .values(recipientRows.slice(i, i + INSERT_BATCH_SIZE))
      }
    } catch (recipErr) {
      // Partial recipient set would desync webhook status updates and
      // aggregate counts — flip to failed and surface the error.
      await db
        .update(broadcasts)
        .set({ status: 'failed', failedCount: input.contactIds.length })
        .where(eq(broadcasts.id, broadcast.id))
      throw recipErr
    }

    return { broadcastId: broadcast.id, error: null }
  } catch (err) {
    return {
      broadcastId: null,
      error: err instanceof Error ? err.message : 'Failed to create broadcast',
    }
  }
}

/**
 * Recipient rows (id + contact_id + phone) for a broadcast, so the hook
 * can build the per-recipient send payload and update statuses by id.
 * Account-scoped through the parent broadcast.
 */
export async function listSendableRecipients(
  broadcastId: string,
): Promise<{ id: string; contact_id: string | null; phone: string | null }[]> {
  const ctx = await getCurrentAccount()
  const parent = firstOrNull(
    await db
      .select({ id: broadcasts.id })
      .from(broadcasts)
      .where(
        and(
          eq(broadcasts.id, broadcastId),
          eq(broadcasts.accountId, ctx.accountId),
        ),
      )
      .limit(1),
  )
  if (!parent) return []

  return db
    .select({
      id: broadcastRecipients.id,
      contact_id: broadcastRecipients.contactId,
      phone: contacts.phone,
    })
    .from(broadcastRecipients)
    .leftJoin(contacts, eq(broadcastRecipients.contactId, contacts.id))
    .where(eq(broadcastRecipients.broadcastId, broadcastId))
}

export interface RecipientStatusUpdate {
  id: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string | null
  error_message?: string | null
}

/**
 * Apply a batch of per-recipient status updates after a send batch.
 * Aggregate broadcast counts are maintained by a DB trigger, so we only
 * touch the recipient rows here. Account-scoped through the broadcast.
 */
export async function updateRecipientStatuses(
  broadcastId: string,
  updates: RecipientStatusUpdate[],
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const parent = firstOrNull(
      await db
        .select({ id: broadcasts.id })
        .from(broadcasts)
        .where(
          and(
            eq(broadcasts.id, broadcastId),
            eq(broadcasts.accountId, ctx.accountId),
          ),
        )
        .limit(1),
    )
    if (!parent) return { error: 'Broadcast not found' }

    for (const u of updates) {
      if (u.status === 'sent') {
        await db
          .update(broadcastRecipients)
          .set({
            status: 'sent',
            sentAt: new Date().toISOString(),
            whatsappMessageId: u.whatsapp_message_id ?? null,
            errorMessage: null,
          })
          .where(
            and(
              eq(broadcastRecipients.id, u.id),
              eq(broadcastRecipients.broadcastId, broadcastId),
            ),
          )
      } else {
        await db
          .update(broadcastRecipients)
          .set({
            status: 'failed',
            errorMessage: u.error_message ?? 'Unknown error',
          })
          .where(
            and(
              eq(broadcastRecipients.id, u.id),
              eq(broadcastRecipients.broadcastId, broadcastId),
            ),
          )
      }
    }
    return { error: null }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to update recipients',
    }
  }
}

// ============================================================
// Humanized text broadcast (RecebAI-style drip) — non-official channels.
// A free-text message trickled out to an audience: at most `dailyCap` per
// day, spread across business hours (08–18h, Mon–Sat, Campo Grande), one
// every window/dailyCap minutes. Server-side (BullMQ), so it survives
// browser close and spans days. Distinct from the template wizard.
// ============================================================

/** Non-official channels (WAHA/Evolution/EvoGo) — the only ones a free-text
 *  drip can go out on (Meta requires an approved template for cold sends). */
export async function listTextBroadcastChannels(): Promise<BroadcastChannel[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: channels.id,
      name: channels.name,
      phone_number: channels.phoneNumber,
      status: channels.status,
      provider: channels.provider,
      dedicated_user_id: channels.dedicatedUserId,
      dedicated_user_name: user.name,
    })
    .from(channels)
    .leftJoin(user, eq(user.id, channels.dedicatedUserId))
    .where(eq(channels.accountId, ctx.accountId))
    .orderBy(channels.name)
  // Não-oficiais (drip com jitter) + canais de E-MAIL (newsletter/segmento).
  return rows
    .filter(
      (r) =>
        r.provider === 'email' ||
        r.provider === 'gmail' ||
        getProvider(r.provider as ProviderId).capabilities.needsJitter,
    )
    .map(({ provider, ...r }) => ({
      ...(r as BroadcastChannel),
      is_email: provider === 'email' || provider === 'gmail',
    }))
}

export interface CreateTextBroadcastInput {
  name?: string | null
  channelId: string
  bodyText: string
  /** Optional media attachment (public URL + kind + filename). */
  mediaUrl?: string | null
  mediaType?: 'image' | 'video' | 'document' | 'audio' | null
  mediaFilename?: string | null
  /** Múltiplos anexos (até 10) — precede mediaUrl. */
  media?: { url: string; type: string; filename?: string | null }[]
  /** Max sends per day (default 50). Window/days/timezone use the defaults. */
  dailyCap?: number
  /** Send starting now (no business-hours wait) instead of the humanized
   *  drip. Useful for tests and urgent sends. */
  sendNow?: boolean
  /** When sendNow: minutes between each message (0 = all at once). */
  sendNowIntervalMin?: number
  /** Anexa a opção de descadastro ("responda SAIR") no fim. Default true. */
  includeOptOut?: boolean
  /** Assunto — obrigatório quando o canal é de e-mail. */
  subject?: string | null
  /** Quem cria confirmou enviar pelo número dedicado a OUTRA pessoa. */
  confirmOtherPersonNumber?: boolean
  /**
   * Pula quem já recebeu esta mesma mensagem nas últimas 24 h (padrão true).
   * false = "enviar mesmo pra quem já recebeu" (15/09, GoLink).
   */
  skipRecentDuplicates?: boolean
  audience: ResolveAudienceInput
}

/**
 * Create + launch a humanized text drip. Resolves the audience, computes a
 * send slot per recipient, persists the broadcast + recipient rows, and
 * enqueues the dispatch (which schedules each recipient at its slot).
 */
export async function createTextBroadcast(
  input: CreateTextBroadcastInput,
): Promise<EnqueueTextBroadcastResult> {
  try {
    const ctx = await requireRole('agent')
    // 15/09 (GoLink): número dedicado a outra pessoa só com confirmação.
    const ownerError = await otherPersonNumberError(ctx.accountId, ctx.userId, input.channelId, input.confirmOtherPersonNumber)
    if (ownerError) return { broadcastId: null, totalRecipients: 0, error: ownerError }
    // Resolve the audience (session-scoped) → account-owned contact ids, then
    // hand off to the shared core (validation / slots / persist / enqueue).
    const contactsList = await resolveAudienceContacts(input.audience)
    const recipientContactIds = contactsList
      .map((c) => c.id)
      .filter((id): id is string => !!id)
    const result = await enqueueTextBroadcast(ctx.accountId, ctx.userId, {
      name: input.name,
      channelId: input.channelId,
      bodyText: input.bodyText,
      mediaUrl: input.mediaUrl,
      mediaType: input.mediaType,
      mediaFilename: input.mediaFilename,
      media: input.media,
      includeOptOut: input.includeOptOut,
      subject: input.subject,
      dailyCap: input.dailyCap,
      sendNow: input.sendNow,
      sendNowIntervalMin: input.sendNowIntervalMin,
      skipRecentDuplicates: input.skipRecentDuplicates,
      recipientContactIds,
      audienceFilter: input.audience,
    })
    if (result.broadcastId) {
      await audit(ctx, 'create', result.broadcastId, {
        channelId: input.channelId,
        extra: {
          total: result.totalRecipients,
          skippedDuplicates: result.skippedDuplicates?.length ?? 0,
          sendNow: !!input.sendNow,
          otherPersonNumber: !!input.confirmOtherPersonNumber,
        },
      })
    }
    return result
  } catch (err) {
    console.error('[broadcast] createTextBroadcast failed:', err)
    return {
      broadcastId: null,
      totalRecipients: 0,
      error: err instanceof Error ? err.message : 'Falha ao criar o disparo.',
    }
  }
}

/**
 * "Enviar agora" on a humanized text drip: flip it to a burst (null pacing)
 * and promote all its pending recipients so they fire immediately instead
 * of waiting for their business-hours slots. No-op-ish for non-paced
 * broadcasts. Account-scoped.
 */
export async function sendBroadcastNowAction(
  broadcastId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const ctx = await requireRole('agent')
    const b = firstOrNull(
      await db
        .select({
          id: broadcasts.id,
          accountId: broadcasts.accountId,
          channelId: broadcasts.channelId,
          status: broadcasts.status,
          pacing: broadcasts.pacing,
        })
        .from(broadcasts)
        .where(
          and(eq(broadcasts.id, broadcastId), eq(broadcasts.accountId, ctx.accountId)),
        )
        .limit(1),
    )
    if (!b) return { ok: false, error: 'Disparo não encontrado.' }
    if (!b.pacing) return { ok: false, error: 'Este disparo já está enviando agora.' }
    if (!['sending', 'scheduled', 'paused'].includes(b.status)) {
      return { ok: false, error: 'O disparo já foi finalizado.' }
    }

    // Keep the SAME spacing the drip used (window ÷ máx/dia), but start now
    // and drop the business-hours gate (null pacing skips the worker guard).
    const cfg = normalizePacing(b.pacing as Partial<PacingConfig>)
    const intervalMs = pacingIntervalMinutes(cfg) * 60_000

    await db
      .update(broadcasts)
      // Voltou a enviar: a pausa (se havia) deixa de valer.
      .set({
        pacing: null,
        status: 'sending',
        pausedBy: null,
        pausedAt: null,
        pauseReason: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(broadcasts.id, b.id))

    const channel = b.channelId
      ? await loadChannel(b.channelId)
      : await loadDefaultChannel(b.accountId)
    if (!channel) return { ok: false, error: 'Canal do disparo não encontrado.' }

    // Pending recipients in their originally-scheduled order, re-anchored to
    // now + i·interval.
    const pending = await db
      .select({ id: broadcastRecipients.id })
      .from(broadcastRecipients)
      .where(
        and(
          eq(broadcastRecipients.broadcastId, b.id),
          eq(broadcastRecipients.status, 'pending'),
        ),
      )
      .orderBy(broadcastRecipients.scheduledSlotAt)

    const now = Date.now()
    for (let i = 0; i < pending.length; i++) {
      const delayMs = i * intervalMs
      await db
        .update(broadcastRecipients)
        .set({ scheduledSlotAt: new Date(now + delayMs).toISOString() })
        .where(eq(broadcastRecipients.id, pending[i].id))
      await rescheduleRecipient(channel.id, b.id, pending[i].id, delayMs)
    }
    await audit(ctx, 'send_now', b.id, {
      channelId: channel.id,
      previousStatus: b.status,
      extra: { pending: pending.length, intervalMs },
    })
    return { ok: true }
  } catch (err) {
    console.error('[broadcast] sendBroadcastNowAction failed:', err)
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Falha ao enviar agora.',
    }
  }
}

// ------------------------------------------------------------
// Broadcast lifecycle controls (Phase 5 UI): pause / resume / cancel.
// The detail page drives these; each resolves the caller's account via
// getCurrentAccount() then delegates to the Next-independent state machine
// in @/lib/queue/broadcast-controls. Returns the ControlResult so the UI
// can surface an invalid-transition message and refetch.
// ------------------------------------------------------------

// 15/09 (GoLink): cada ação deixa rastro (quem/qual disparo/quantos já
// tinham saído) — e pausar grava quem pausou pra tela mostrar.

export async function pauseBroadcastAction(
  broadcastId: string,
): Promise<ControlResult> {
  // Só leitura não mexe em disparo (revisão 15/09).
  const ctx = await getCurrentAccount()
  if (!hasMinRole(ctx.role, 'agent')) {
    return { ok: false, status: 'unknown', code: 'invalid_state', message: 'Seu acesso é só de leitura — peça a um agente.' }
  }
  const result = await pauseBroadcast(broadcastId, ctx.accountId, ctx.userId)
  if (result.ok) {
    await audit(ctx, 'pause', broadcastId, {
      ...(await auditSnapshot(broadcastId, ctx.accountId)),
      previousStatus: result.previousStatus,
    })
  }
  return result
}

export async function resumeBroadcastAction(
  broadcastId: string,
): Promise<ControlResult> {
  // Só leitura não mexe em disparo (revisão 15/09).
  const ctx = await getCurrentAccount()
  if (!hasMinRole(ctx.role, 'agent')) {
    return { ok: false, status: 'unknown', code: 'invalid_state', message: 'Seu acesso é só de leitura — peça a um agente.' }
  }
  const result = await resumeBroadcast(broadcastId, ctx.accountId)
  if (result.ok) {
    await audit(ctx, 'resume', broadcastId, {
      ...(await auditSnapshot(broadcastId, ctx.accountId)),
      previousStatus: result.previousStatus,
      extra: { pending: result.schedule?.pending ?? null },
    })
  }
  return result
}

export async function cancelBroadcastAction(
  broadcastId: string,
): Promise<ControlResult> {
  // Só leitura não mexe em disparo (revisão 15/09).
  const ctx = await getCurrentAccount()
  if (!hasMinRole(ctx.role, 'agent')) {
    return { ok: false, status: 'unknown', code: 'invalid_state', message: 'Seu acesso é só de leitura — peça a um agente.' }
  }
  const result = await cancelBroadcast(broadcastId, ctx.accountId)
  if (result.ok) {
    await audit(ctx, 'cancel', broadcastId, {
      ...(await auditSnapshot(broadcastId, ctx.accountId)),
      previousStatus: result.previousStatus,
    })
  }
  return result
}

/** "Reenviar falhados" — requeue only the failed recipients of a broadcast. */
export async function retryFailedBroadcastAction(
  broadcastId: string,
): Promise<ControlResult & { requeued?: number }> {
  // Só leitura não mexe em disparo (revisão 15/09).
  const ctx = await getCurrentAccount()
  if (!hasMinRole(ctx.role, 'agent')) {
    return { ok: false, status: 'unknown', code: 'invalid_state', message: 'Seu acesso é só de leitura — peça a um agente.' }
  }
  const result = await retryFailedBroadcast(broadcastId, ctx.accountId)
  if (result.ok) {
    await audit(ctx, 'retry', broadcastId, {
      ...(await auditSnapshot(broadcastId, ctx.accountId)),
      previousStatus: result.previousStatus,
      extra: { requeued: result.requeued ?? 0 },
    })
  }
  return result
}

/** Flip a broadcast's final status once the send loop completes. */
export async function finalizeBroadcastStatus(
  broadcastId: string,
  status: 'sent' | 'failed',
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .update(broadcasts)
      .set({ status })
      .where(
        and(
          eq(broadcasts.id, broadcastId),
          eq(broadcasts.accountId, ctx.accountId),
        ),
      )
    return { error: null }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to finalize broadcast',
    }
  }
}
