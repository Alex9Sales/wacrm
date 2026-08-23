// ============================================================
// Public-API broadcast core.
//
// Splits a broadcast into two phases so the HTTP route can persist +
// acknowledge fast and fan out afterwards (in `after()`):
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending'), return a plan.
//   deliverBroadcast() — send each recipient's template via Meta
//                        (phone-variant retry), stamp each recipient
//                        row + the aggregate counts, finalize status.
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for API broadcasts exactly as it does for dashboard ones.
// ============================================================

import { and, eq } from 'drizzle-orm';

import {
  db,
  broadcastRecipients,
  broadcasts,
  messageTemplates,
} from '@/db';
import { firstOrNull, firstOrThrow } from '@/db/helpers';
import { loadChannel, loadDefaultChannel } from '@/lib/channels/channels';
import { getProvider } from '@/lib/channels/registry';
import type { ChannelCtx } from '@/lib/channels/provider';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { renderMessageVars } from '@/lib/whatsapp/message-vars';
import { appendOptOutLine } from '@/lib/contacts/opt-out';
import type { OutboundMedia } from '@/lib/channels/provider';
import type { MessageTemplate } from '@/types';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import { findOrCreateContact } from '@/lib/api/v1/contacts';

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). */
  params?: string[];
  /**
   * Structured per-send values (header text/media, URL/COPY_CODE button
   * values) — the dashboard's richer send path. Threaded to the provider
   * as `OutboundTemplate.params.messageParams` and persisted per recipient
   * so the queue worker can rebuild the send after a restart.
   */
  messageParams?: SendTimeParams;
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
  // When omitted we fall back to the account's default channel. The
  // resolved channel id is now persisted on the broadcast row so the
  // queue worker can rebuild the send context after a restart.
  channelId?: string | null;
  /**
   * ISO timestamp to schedule the send. When in the future the caller
   * enqueues the dispatch with a delay and sets status 'scheduled';
   * persisted on the row for auditing.
   */
  scheduledAt?: string | null;
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
  messageParams?: SendTimeParams;
}

export interface BroadcastPlan {
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  /** The channel (decrypted ctx) the broadcast sends on. Its provider is
   *  resolved via getProvider() in deliverBroadcast. */
  channel: ChannelCtx;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
  /**
   * Epoch ms the send is scheduled for, or null for send-now. The route
   * turns a future value into the dispatch job's `delayMs`.
   */
  scheduledAtMs: number | null;
  /** Initial persisted status: 'scheduled' when scheduled, else 'sending'. */
  status: 'scheduled' | 'sending';
}

// A broadcast is now fanned out through a durable BullMQ queue, so the
// old per-request cap (which existed because the immediate `after()` loop
// could exceed the route's max duration) is relaxed to a high sanity
// bound. Override via BROADCAST_MAX_RECIPIENTS.
const MAX_RECIPIENTS = (() => {
  const raw = Number(process.env.BROADCAST_MAX_RECIPIENTS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50_000;
})();

/**
 * Load the local template row (header/button components) matching
 * name+language for an account, aliased to the public `MessageTemplate`
 * shape. Throws {@link BroadcastError} if the row is malformed locally.
 * Shared by createBroadcast and the queue worker.
 */
export async function loadBroadcastTemplateRow(
  accountId: string,
  templateName: string,
  templateLanguage: string,
): Promise<MessageTemplate | null> {
  const rawTemplateRow = firstOrNull(
    await db
      .select({
        id: messageTemplates.id,
        user_id: messageTemplates.userId,
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
          eq(messageTemplates.accountId, accountId),
          eq(messageTemplates.name, templateName),
          eq(messageTemplates.language, templateLanguage),
        ),
      )
      .limit(1),
  );
  if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500,
    );
  }
  return (rawTemplateRow as MessageTemplate | null) ?? null;
}

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params;
  const templateLanguage = params.templateLanguage || 'en_US';

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  // A future scheduled_at means the dispatch is delayed; the row starts
  // 'scheduled'. Otherwise it starts 'sending' (the dispatch worker will
  // (re)affirm 'sending' when it runs). An invalid date is ignored.
  const scheduledAtMs = params.scheduledAt
    ? Date.parse(params.scheduledAt)
    : NaN;
  const isScheduled = Number.isFinite(scheduledAtMs) && scheduledAtMs > Date.now();

  // Channel (fail fast). Broadcasts go out on a channel; prefer the
  // explicit channelId the caller chose, else the account's default
  // channel. Credentials arrive already-decrypted on the ChannelCtx.
  const channel = params.channelId
    ? await loadChannel(params.channelId)
    : await loadDefaultChannel(accountId);
  if (!channel || channel.accountId !== accountId) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please connect a channel first.',
      400
    );
  }
  // Templates only exist on the official Meta channel — reject a broadcast
  // on a non-Meta channel up front with a clean 422.
  const provider = getProvider(channel.provider);
  if (!provider.capabilities.templates || !provider.sendTemplate) {
    throw new BroadcastError(
      'unsupported',
      'Broadcasts por template só no canal oficial (Meta).',
      422
    );
  }

  // Template row (once) for header/button components; guard a
  // malformed local row rather than N identical opaque failures.
  const templateRow = await loadBroadcastTemplateRow(
    accountId,
    templateName,
    templateLanguage,
  );

  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  const resolved: {
    contactId: string;
    phone: string;
    params: string[];
    messageParams?: SendTimeParams;
  }[] = [];
  let rejected = 0;
  for (const r of recipients) {
    const sanitized = sanitizePhoneForMeta(typeof r.to === 'string' ? r.to : '');
    if (!isValidE164(sanitized)) {
      rejected++;
      continue;
    }
    const { id } = await findOrCreateContact(accountId, auditUserId, {
      phone: sanitized,
    });
    resolved.push({
      contactId: id,
      phone: sanitized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
      messageParams: r.messageParams,
    });
  }

  // Collapse recipients that resolved to the SAME contact (the caller
  // listed a phone twice, or two numbers fuzzy-matched to one contact).
  // Keep the first occurrence so the contact is messaged once and its
  // params aren't silently overwritten by a later duplicate — and so
  // the row↔params pairing below (keyed by contact_id) is unambiguous.
  const seenContact = new Set<string>();
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid E.164 phone number',
      400
    );
  }

  // Persist the broadcast + its recipients. The count columns
  // (sent/delivered/read/replied/failed) are owned by the DB aggregate
  // trigger (migrations 003/005) and derived purely from
  // broadcast_recipients rows — we deliberately do NOT seed them here
  // (a manual value would be clobbered by the trigger on the first
  // recipient change). `rejected` phones have no recipient row, so they
  // are reported to the caller in the POST response, not in these
  // persisted counts.
  let broadcast: { id: string };
  try {
    broadcast = firstOrThrow(
      await db
        .insert(broadcasts)
        .values({
          accountId,
          userId: auditUserId,
          name: name || `API broadcast (${templateName})`,
          channelId: channel.id,
          templateName,
          templateLanguage,
          status: isScheduled ? 'scheduled' : 'sending',
          scheduledAt: isScheduled
            ? new Date(scheduledAtMs).toISOString()
            : null,
          totalRecipients: deduped.length,
        })
        .returning({ id: broadcasts.id })
    );
  } catch (bErr) {
    console.error('[broadcast-core] create broadcast error:', bErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  let recipientRows: { id: string; contactId: string | null }[];
  try {
    recipientRows = await db
      .insert(broadcastRecipients)
      .values(
        deduped.map((r) => ({
          broadcastId: broadcast.id,
          contactId: r.contactId,
          status: 'pending' as const,
          params: r.params,
          messageParams: r.messageParams ?? null,
        }))
      )
      .returning({
        id: broadcastRecipients.id,
        contactId: broadcastRecipients.contactId,
      });
  } catch (rErr) {
    console.error('[broadcast-core] create recipients error:', rErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  // Pair each inserted recipient row back to its phone/params by
  // contact_id — unambiguous now that duplicates are collapsed.
  const byContact = new Map(deduped.map((r) => [r.contactId, r]));
  const planned: PlannedRecipient[] = recipientRows.map((row) => {
    const r = byContact.get(row.contactId as string)!;
    return {
      recipientRowId: row.id,
      phone: r.phone,
      params: r.params,
      messageParams: r.messageParams,
    };
  });

  return {
    broadcastId: broadcast.id,
    templateName,
    templateLanguage,
    channel,
    templateRow,
    planned,
    rejected,
    scheduledAtMs: isScheduled ? scheduledAtMs : null,
    status: isScheduled ? 'scheduled' : 'sending',
  };
}

// ---- shared single-recipient send --------------------------------------

/** What the send helper needs about the broadcast (template identity, or
 *  the free-text body + optional media for a 'text' drip). */
export interface BroadcastSendContext {
  /** 'template' (Meta) or 'text' (free-text drip on a non-official channel). */
  messageKind?: 'template' | 'text';
  /** Anexa a opção de descadastro ("responda SAIR") no fim de cada 'text'. */
  includeOptOut?: boolean;
  /** The message body for a 'text' broadcast (may contain {{tokens}}). */
  bodyText?: string | null;
  /** Assunto quando o canal é de e-mail (email/gmail); WhatsApp ignora. */
  subject?: string | null;
  /** Optional media attachment for a 'text' broadcast. */
  mediaUrl?: string | null;
  mediaType?: string | null;
  mediaFilename?: string | null;
  templateName: string;
  templateLanguage: string;
  templateRow: MessageTemplate | null;
}

/** One recipient's phone + body params (+ optional structured params). */
export interface RecipientSendInput {
  phone: string;
  params: string[];
  messageParams?: SendTimeParams;
  /** Personalization values for {{tokens}} in a 'text' body (nome, etc.). */
  vars?: Record<string, string>;
}

/** Outcome of a single send attempt (no DB writes performed here). */
export type RecipientSendResult =
  | { ok: true; externalMessageId: string }
  | { ok: false; error: string };

/**
 * Send ONE recipient's template on `channel` (Meta phone-variant retry).
 * Pure send — performs NO DB writes, so both the legacy
 * {@link deliverBroadcast} loop and the queue worker can call it and own
 * their own persistence/retry policy. Throws only if the channel's
 * provider can't send templates at all (a programmer error by then).
 */
export async function sendBroadcastRecipient(
  channel: ChannelCtx,
  ctx: BroadcastSendContext,
  recipient: RecipientSendInput,
): Promise<RecipientSendResult> {
  const provider = getProvider(channel.provider);

  // Free-text drip: personalize the body per recipient, then send — either
  // as media (with the text as caption) or as a plain text message. The
  // provider (WAHA/Evolution/EvoGo) resolves its own chatId. No template.
  if (ctx.messageKind === 'text') {
    const rawBody = ctx.bodyText ?? '';
    let body = renderMessageVars(rawBody, recipient.vars ?? {}).trim();
    // Anti-ban: anexa a opção de descadastro ("responda SAIR") no fim.
    if (ctx.includeOptOut) body = appendOptOutLine(body);
    const mediaUrl = (ctx.mediaUrl ?? '').trim();

    try {
      if (mediaUrl) {
        const kind = (ctx.mediaType as OutboundMedia['kind']) || 'image';
        // Audio carries no caption on WhatsApp; everything else uses the
        // personalized text as the caption.
        const media: OutboundMedia = {
          kind,
          url: mediaUrl,
          caption: kind === 'audio' || !body ? undefined : body,
          filename: ctx.mediaFilename ?? undefined,
        };
        const result = await provider.sendMedia(channel, recipient.phone, media);
        return { ok: true, externalMessageId: result.externalMessageId };
      }

      if (!body) return { ok: false, error: 'empty text body' };
      const result = await provider.sendText(
        channel,
        recipient.phone,
        body,
        ctx.subject ? { subject: ctx.subject } : {},
      );
      return { ok: true, externalMessageId: result.externalMessageId };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  if (!provider.sendTemplate) {
    throw new BroadcastError(
      'unsupported',
      'Broadcasts por template só no canal oficial (Meta).',
      422,
    );
  }
  // Phone-variant retry (#131030) is Meta-specific — other providers
  // resolve their own chatId or don't need it.
  const useVariants = provider.id === 'meta';
  const variants = useVariants
    ? phoneVariants(recipient.phone)
    : [recipient.phone];

  let lastError = 'Unknown error';
  for (const variant of variants) {
    try {
      const result = await provider.sendTemplate(channel, variant, {
        name: ctx.templateName,
        language: ctx.templateLanguage,
        params: {
          template: ctx.templateRow ?? undefined,
          body: recipient.params,
          messageParams: recipient.messageParams,
        },
      });
      return { ok: true, externalMessageId: result.externalMessageId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      lastError = message;
      // Only a Meta "recipient not allowed" error is worth another variant.
      if (!useVariants || !isRecipientNotAllowedError(message)) break;
    }
  }
  return { ok: false, error: lastError };
}

/**
 * Fan out a {@link BroadcastPlan} synchronously (the legacy immediate
 * loop). Kept for direct callers/tests; the production path now uses the
 * BullMQ queue (see src/worker). Best-effort per recipient — one failure
 * never aborts the rest.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger: each recipient-row update below advances them
 * automatically, and later Meta delivery/read webhooks keep advancing
 * them. We only write the terminal `status` here.
 */
export async function deliverBroadcast(plan: BroadcastPlan): Promise<void> {
  let sentCount = 0;
  const ctx: BroadcastSendContext = {
    templateName: plan.templateName,
    templateLanguage: plan.templateLanguage,
    templateRow: plan.templateRow,
  };

  for (const recipient of plan.planned) {
    const result = await sendBroadcastRecipient(plan.channel, ctx, {
      phone: recipient.phone,
      params: recipient.params,
      messageParams: recipient.messageParams,
    });

    if (result.ok) {
      sentCount++;
      await db
        .update(broadcastRecipients)
        .set({
          status: 'sent',
          sentAt: new Date().toISOString(),
          whatsappMessageId: result.externalMessageId,
          errorMessage: null,
        })
        .where(eq(broadcastRecipients.id, recipient.recipientRowId));
    } else {
      await db
        .update(broadcastRecipients)
        .set({
          status: 'failed',
          errorMessage: result.error,
        })
        .where(eq(broadcastRecipients.id, recipient.recipientRowId));
    }
  }

  await db
    .update(broadcasts)
    .set({
      status: sentCount > 0 ? 'sent' : 'failed',
      updatedAt: new Date().toISOString(),
    })
    .where(eq(broadcasts.id, plan.broadcastId));
}
