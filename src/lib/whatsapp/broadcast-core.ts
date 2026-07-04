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
import type { MessageTemplate } from '@/types';
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
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
  // TODO(wave-3B): make broadcasts channel-explicit — the broadcast route
  // should pass the channel the user chose to send on. Until then, when
  // `channelId` is omitted we fall back to the account's default channel.
  channelId?: string | null;
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
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
}

const MAX_RECIPIENTS = 1000;

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
  // Selected with snake_case aliases so the row matches the public
  // `MessageTemplate` shape the send-builder expects.
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
          eq(messageTemplates.language, templateLanguage)
        )
      )
      .limit(1)
  );
  if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500
    );
  }
  const templateRow = (rawTemplateRow as MessageTemplate | null) ?? null;

  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  const resolved: { contactId: string; phone: string; params: string[] }[] = [];
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
          templateName,
          templateLanguage,
          status: 'sending',
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
    return { recipientRowId: row.id, phone: r.phone, params: r.params };
  });

  return {
    broadcastId: broadcast.id,
    templateName,
    templateLanguage,
    channel,
    templateRow,
    planned,
    rejected,
  };
}

/**
 * Fan out a {@link BroadcastPlan}: send each recipient's template
 * (phone-variant retry) and stamp its `broadcast_recipients` row.
 * Best-effort per recipient — one failure never aborts the rest.
 * Designed to run inside `after()`.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger (migrations 003/005): each recipient-row update
 * below advances them automatically, and later Meta delivery/read
 * webhooks keep advancing them. We therefore never write those columns
 * here — only the terminal `status` — otherwise a manual value would
 * race and clobber the trigger-maintained counts.
 */
export async function deliverBroadcast(plan: BroadcastPlan): Promise<void> {
  let sentCount = 0;
  const provider = getProvider(plan.channel.provider);
  // The capability gate in createBroadcast already guarantees sendTemplate
  // exists; assert it here so the loop can call it unconditionally.
  if (!provider.sendTemplate) {
    throw new BroadcastError(
      'unsupported',
      'Broadcasts por template só no canal oficial (Meta).',
      422
    );
  }
  // Phone-variant retry (#131030) is Meta-specific — other providers
  // resolve their own chatId or don't need it.
  const useVariants = provider.id === 'meta';

  for (const recipient of plan.planned) {
    const variants = useVariants
      ? phoneVariants(recipient.phone)
      : [recipient.phone];
    let sentMessageId: string | null = null;
    let lastError: string | null = null;

    for (const variant of variants) {
      try {
        const result = await provider.sendTemplate(plan.channel, variant, {
          name: plan.templateName,
          language: plan.templateLanguage,
          params: {
            template: plan.templateRow ?? undefined,
            body: recipient.params,
          },
        });
        sentMessageId = result.externalMessageId;
        lastError = null;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        lastError = message;
        // Only a Meta "recipient not allowed" error is worth another variant.
        if (!useVariants || !isRecipientNotAllowedError(message)) break;
      }
    }

    if (sentMessageId) {
      sentCount++;
      await db
        .update(broadcastRecipients)
        .set({
          status: 'sent',
          sentAt: new Date().toISOString(),
          whatsappMessageId: sentMessageId,
          errorMessage: null,
        })
        .where(eq(broadcastRecipients.id, recipient.recipientRowId));
    } else {
      await db
        .update(broadcastRecipients)
        .set({
          status: 'failed',
          errorMessage: lastError || 'Unknown error',
        })
        .where(eq(broadcastRecipients.id, recipient.recipientRowId));
    }
  }

  // Terminal status only — counts are trigger-owned (see the note
  // above). If nothing sent, the broadcast failed outright; a partial
  // send is still 'sent' (per-recipient failures show in failed_count).
  await db
    .update(broadcasts)
    .set({
      status: sentCount > 0 ? 'sent' : 'failed',
      updatedAt: new Date().toISOString(),
    })
    .where(eq(broadcasts.id, plan.broadcastId));
}
