// ============================================================
// Resolve (or create) the conversation for a phone number.
//
// The dashboard composer always has a `conversation_id` in hand. The
// public API doesn't — an external automation knows a *phone number*,
// not an internal UUID. This helper bridges that: given an E.164
// phone, it finds-or-creates the contact and its conversation so the
// shared `sendMessageToConversation` core can run unchanged.
//
// It deliberately reuses the exact find-or-create logic the inbound
// webhook uses (the `findExistingContact` dedupe helper, the
// one-conversation-per-(account, contact) convention, the
// account_id-tenancy / user_id-audit split) so a contact created via
// the API is indistinguishable from one created by an inbound message.
//
// Audit user: created rows need a NOT NULL `user_id`. As with the
// webhook (where there's no logged-in human either), we attribute
// them to the WhatsApp config owner — a stable account-level default.
// ============================================================

import { and, eq } from 'drizzle-orm';

import { db, contacts, conversations } from '@/db';
import { firstOrNull, firstOrThrow } from '@/db/helpers';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { loadChannel, loadDefaultChannel } from '@/lib/channels/channels';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';

export interface ResolvedConversation {
  conversationId: string;
  contactId: string;
  /** True if this call created the contact (vs matched an existing one). */
  contactCreated: boolean;
}

/**
 * Find or create the contact + conversation for `phone` within
 * `accountId`. Throws `SendMessageError` (shared with the send core,
 * so the route maps one error family) on a bad phone, a missing
 * channel, or a DB failure.
 *
 * Phase 4: conversations are keyed on (account, contact, channel). The
 * caller may pass an explicit `channelId`; otherwise the account's default
 * channel is used. A created conversation is stamped with that channel_id
 * so it matches the one-conversation-per-(account, contact, channel) unique
 * index the inbound pipeline relies on.
 */
export async function resolveConversationByPhone(
  accountId: string,
  phone: string,
  name?: string | null,
  channelId?: string | null
): Promise<ResolvedConversation> {
  const sanitized = sanitizePhoneForMeta(phone);
  if (!isValidE164(sanitized)) {
    throw new SendMessageError(
      'bad_request',
      "'to' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400
    );
  }

  // Resolve the channel (fail fast + create nothing when the account has no
  // channel connected). An explicit channelId wins; else the account's
  // default channel. A channel from another account is treated as missing.
  const channel = channelId
    ? await loadChannel(channelId)
    : await loadDefaultChannel(accountId);
  if (!channel || channel.accountId !== accountId) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please connect a channel first.',
      400
    );
  }
  const resolvedChannelId = channel.id;

  // Audit user for created rows = the single account-wide default used
  // by every public-API write (see resolveAuditUserId), so a contact
  // created here is attributed identically to one created via
  // POST /api/v1/contacts. resolveAuditUserId throws ContactError only
  // if the owner can't be resolved — remap it to the send error family
  // the callers already handle.
  let ownerUserId: string;
  try {
    ownerUserId = await resolveAuditUserId(accountId);
  } catch (err) {
    if (err instanceof ContactError) {
      throw new SendMessageError('db_error', err.message, err.status);
    }
    throw err;
  }

  // ---- contact -------------------------------------------------
  let contactId: string;
  let contactCreated = false;

  const existing = await findExistingContact(accountId, sanitized);
  if (existing) {
    contactId = existing.id;
    if (name && name !== existing.name) {
      await db
        .update(contacts)
        .set({ name, updatedAt: new Date().toISOString() })
        .where(eq(contacts.id, existing.id));
    }
  } else {
    let created: { id: string } | null = null;
    try {
      created = firstOrThrow(
        await db
          .insert(contacts)
          .values({
            accountId,
            userId: ownerUserId,
            phone: sanitized,
            name: name || sanitized,
          })
          .returning({ id: contacts.id })
      );
    } catch (createErr) {
      // Lost a race against a concurrent inbound/API create — the
      // unique index (migration 022) rejected the duplicate. Re-resolve.
      if (isUniqueViolation(createErr)) {
        const raced = await findExistingContact(accountId, sanitized);
        if (raced) {
          contactId = raced.id;
        } else {
          throw new SendMessageError(
            'db_error',
            'Failed to create contact',
            500
          );
        }
      } else {
        console.error(
          '[resolve-conversation] contact create error:',
          createErr
        );
        throw new SendMessageError('db_error', 'Failed to create contact', 500);
      }
    }
    if (created) {
      contactId = created.id;
      contactCreated = true;
    }
  }

  // ---- conversation -------------------------------------------
  // One conversation per (account, contact, channel) — same convention as
  // the inbound pipeline (inbound.ts).
  const conv = firstOrNull(
    await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.accountId, accountId),
          eq(conversations.contactId, contactId!),
          eq(conversations.channelId, resolvedChannelId)
        )
      )
      .limit(1)
  );

  if (conv?.id) {
    return { conversationId: conv.id, contactId: contactId!, contactCreated };
  }

  let newConv: { id: string };
  try {
    newConv = firstOrThrow(
      await db
        .insert(conversations)
        .values({
          accountId,
          userId: ownerUserId,
          contactId: contactId!,
          channelId: resolvedChannelId,
        })
        .returning({ id: conversations.id })
    );
  } catch (convErr) {
    console.error('[resolve-conversation] conversation create error:', convErr);
    throw new SendMessageError(
      'db_error',
      'Failed to create conversation',
      500
    );
  }

  return { conversationId: newConv.id, contactId: contactId!, contactCreated };
}
