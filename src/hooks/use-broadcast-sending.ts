'use client';

import { useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import {
  resolveAudienceContacts,
  createBroadcastWithRecipients,
  listSendableRecipients,
  listContactCustomValues,
  updateRecipientStatuses,
  finalizeBroadcastStatus,
  type RecipientStatusUpdate,
} from '@/app/(dashboard)/broadcasts/actions';
import { Contact, MessageTemplate } from '@/types';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

/**
 * Variable mapping — each template placeholder (by key, usually "1",
 * "2", …) is resolved at send time. `field` maps to a built-in contact
 * field (name/phone/email/company); `custom_field` maps to a
 * contact_custom_values.value row keyed by the custom_fields.id stored
 * in `value`.
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header. Required at send
   * time for media-header templates — Meta rejects the send without
   * it. Passed through as `messageParams.headerMediaUrl`; the builder
   * falls back to the template's stored URL only when this is empty.
   */
  headerMediaUrl?: string;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

/**
 * Meta rate-limit buffer. 10 per batch + 1 s pause matches the spec
 * and keeps us comfortably under Meta's per-phone-number messaging
 * rate so a large broadcast never trips the upstream limiter.
 */
const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BroadcastApiResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

/** contactId → (customFieldId → value). */
type CustomValueIndex = Map<string, Map<string, string>>;

/**
 * Per-contact resolution of custom-field placeholders. Static and
 * built-in-field mappings resolve synchronously; custom fields read
 * from a pre-built index to avoid N+1 queries during the send loop.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): string[] {
  // Keys are typically "1","2",... — numeric-aware sort keeps
  // {{1}} before {{10}}.
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    if (v.type === 'static') return v.value;

    if (v.type === 'field') {
      const fieldMap: Record<string, string | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return fieldMap[v.value] ?? '';
    }

    // custom_field
    return customValues?.get(v.value) ?? '';
  });
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    try {
      // The caller (user + account) is derived server-side via
      // getCurrentAccount() inside every action below — no browser
      // session lookup. accountId is still surfaced by useAuth() as a
      // fast client-side guard so we fail before hitting the server
      // when the profile isn't linked.
      if (!accountId) {
        throw new Error('Your profile is not linked to an account.');
      }

      // ── Step 1: Resolve audience contacts (server action) ─────────
      // Audience resolution, CSV contact upsert, and exclude-tag
      // subtraction all happen server-side, account-scoped.
      setProgress(5);
      const contacts = await resolveAudienceContacts({
        type: payload.audience.type,
        tagIds: payload.audience.tagIds,
        customField: payload.audience.customField,
        csvContacts: payload.audience.csvContacts,
        excludeTagIds: payload.audience.excludeTagIds,
      });

      if (contacts.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      // ── Step 2+3: Create broadcast + recipient rows (server action) ─
      setProgress(15);
      const { broadcastId, error: createError } =
        await createBroadcastWithRecipients({
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          template_variables: payload.variables,
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
          },
          contactIds: contacts.map((c) => c.id),
        });

      if (createError || !broadcastId) {
        throw new Error(
          `Failed to create broadcast: ${createError ?? 'unknown error'}`,
        );
      }

      // ── Step 4: Fetch recipients + preload custom values ──────────
      setProgress(30);
      const recipients = await listSendableRecipients(broadcastId);

      // Index the resolved contacts by id so we can build per-recipient
      // params. Recipients only carry id/contact_id/phone from the
      // action; the full contact (for field mappings) comes from the
      // set we already resolved.
      const contactById = new Map<string, Contact>();
      for (const c of contacts) contactById.set(c.id, c);

      // One bulk fetch of custom values for every contact in this
      // broadcast, avoiding N+1 during the send loop.
      const contactIds = recipients
        .map((r) => r.contact_id)
        .filter((id): id is string => Boolean(id));
      const customValueRows = await listContactCustomValues(contactIds);
      const customValueIndex: CustomValueIndex = new Map();
      for (const row of customValueRows) {
        const bucket =
          customValueIndex.get(row.contact_id) ?? new Map<string, string>();
        bucket.set(row.custom_field_id, row.value ?? '');
        customValueIndex.set(row.contact_id, bucket);
      }

      let failedCount = 0;
      const totalRecipients = recipients.length;

      // Media-header templates (image/video/document) require a media
      // URL on every send. Collected in the personalize step and applied
      // to all recipients; falls back to the template's stored URL on the
      // server when omitted.
      const headerType = payload.template.header_type;
      const isMediaHeader =
        headerType === 'image' ||
        headerType === 'video' ||
        headerType === 'document';
      const headerMediaUrl = payload.headerMediaUrl?.trim();
      const messageParams =
        isMediaHeader && headerMediaUrl ? { headerMediaUrl } : undefined;

      for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
        const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

        const apiRecipients = batch
          .filter((r) => r.phone)
          .map((r) => {
            const contact = r.contact_id
              ? contactById.get(r.contact_id)
              : undefined;
            return {
              phone: r.phone as string,
              params: contact
                ? resolveVariables(
                    payload.variables,
                    contact,
                    customValueIndex.get(contact.id),
                  )
                : [],
              ...(messageParams ? { messageParams } : {}),
            };
          });

        const statusUpdates: RecipientStatusUpdate[] = [];

        if (apiRecipients.length === 0) {
          // Whole batch had no phone — mark each failed and move on.
          for (const recipient of batch) {
            failedCount++;
            statusUpdates.push({
              id: recipient.id,
              status: 'failed',
              error_message: 'No phone number on contact',
            });
          }
          await updateRecipientStatuses(broadcastId, statusUpdates);
          continue;
        }

        try {
          const res = await fetch('/api/whatsapp/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recipients: apiRecipients,
              template_name: payload.template.name,
              template_language: payload.template.language ?? 'en_US',
            }),
          });

          const data = await res.json();

          if (!res.ok) {
            throw new Error(data.error || 'Broadcast API request failed');
          }

          const resultsByPhone = new Map<string, BroadcastApiResult>();
          for (const r of (data.results ?? []) as BroadcastApiResult[]) {
            resultsByPhone.set(r.phone, r);
          }

          for (const recipient of batch) {
            const phone = recipient.phone;
            const result = phone ? resultsByPhone.get(phone) : undefined;

            if (!result) {
              failedCount++;
              statusUpdates.push({
                id: recipient.id,
                status: 'failed',
                error_message: 'No phone number on contact',
              });
              continue;
            }

            if (result.status === 'sent') {
              statusUpdates.push({
                id: recipient.id,
                status: 'sent',
                whatsapp_message_id: result.whatsapp_message_id ?? null,
              });
            } else {
              failedCount++;
              statusUpdates.push({
                id: recipient.id,
                status: 'failed',
                error_message: result.error ?? 'Unknown error',
              });
            }
          }
        } catch (err) {
          for (const recipient of batch) {
            failedCount++;
            statusUpdates.push({
              id: recipient.id,
              status: 'failed',
              error_message:
                err instanceof Error ? err.message : 'Unknown error',
            });
          }
        }

        // Persist this batch's statuses server-side (one round-trip per
        // batch instead of per-recipient). Aggregate counts are kept by
        // the DB trigger.
        await updateRecipientStatuses(broadcastId, statusUpdates);

        const progressPct =
          30 + Math.round(((i + batch.length) / totalRecipients) * 60);
        setProgress(progressPct);

        if (i + SEND_BATCH_SIZE < recipients.length) {
          await sleep(SEND_BATCH_DELAY_MS);
        }
      }

      // ── Step 5: Finalize status ───────────────────────────────────
      setProgress(95);
      const finalStatus = failedCount === totalRecipients ? 'failed' : 'sent';
      await finalizeBroadcastStatus(broadcastId, finalStatus);

      setProgress(100);
      return broadcastId;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
