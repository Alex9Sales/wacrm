'use client';

import { useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import {
  resolveAudienceContacts,
  listContactCustomValues,
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
  /**
   * Meta channel (channels.id) to send from. Optional — the backend
   * falls back to the account's default channel when omitted. The wizard
   * defaults it silently when the account has a single Meta channel.
   */
  channelId?: string;
  /**
   * ISO timestamp to schedule the send. Empty/omitted ⇒ send now. When in
   * the future the broadcast is persisted as 'scheduled' and the worker
   * picks it up at that time.
   */
  scheduledAt?: string;
}

interface UseBroadcastSendingReturn {
  /**
   * Phase 5 CORE: enqueue-and-redirect. Resolves the audience, builds
   * per-recipient params, POSTs to the async broadcast endpoint (202),
   * and returns the new broadcast id. Progress is now server-side — the
   * caller navigates to the detail page, which polls for live counts. The
   * old client-driven send loop (and its per-recipient `progress`) is
   * gone; `progress` is retained only as a coarse enqueue indicator.
   */
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

/** contactId → (customFieldId → value). */
type CustomValueIndex = Map<string, Map<string, string>>;

/**
 * Per-contact resolution of custom-field placeholders. Static and
 * built-in-field mappings resolve synchronously; custom fields read
 * from a pre-built index to avoid N+1 queries during payload assembly.
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
      // getCurrentAccount() inside every action below. accountId is still
      // surfaced by useAuth() as a fast client-side guard so we fail before
      // hitting the server when the profile isn't linked.
      if (!accountId) {
        throw new Error('Your profile is not linked to an account.');
      }

      // ── Step 1: Resolve audience contacts (server action) ─────────
      // Audience resolution, CSV contact upsert, and exclude-tag
      // subtraction all happen server-side, account-scoped.
      setProgress(15);
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

      // ── Step 2: Preload custom values → build per-recipient params ──
      // One bulk fetch of custom values for every contact, avoiding N+1
      // while assembling the send payload.
      setProgress(40);
      const contactIds = contacts.map((c) => c.id);
      const customValueRows = await listContactCustomValues(contactIds);
      const customValueIndex: CustomValueIndex = new Map();
      for (const row of customValueRows) {
        const bucket =
          customValueIndex.get(row.contact_id) ?? new Map<string, string>();
        bucket.set(row.custom_field_id, row.value ?? '');
        customValueIndex.set(row.contact_id, bucket);
      }

      // Media-header templates (image/video/document) require a media URL
      // on every send. Collected in the personalize step and applied to
      // all recipients; falls back to the template's stored URL on the
      // server when omitted.
      const headerType = payload.template.header_type;
      const isMediaHeader =
        headerType === 'image' ||
        headerType === 'video' ||
        headerType === 'document';
      const headerMediaUrl = payload.headerMediaUrl?.trim();
      const messageParams =
        isMediaHeader && headerMediaUrl ? { headerMediaUrl } : undefined;

      const recipients = contacts
        .filter((c) => c.phone)
        .map((c) => ({
          phone: c.phone as string,
          params: resolveVariables(
            payload.variables,
            c,
            customValueIndex.get(c.id),
          ),
          ...(messageParams ? { messageParams } : {}),
        }));

      if (recipients.length === 0) {
        throw new Error('No contacts with a phone number in this audience.');
      }

      // ── Step 3: Enqueue (async, 202) ──────────────────────────────
      // The route persists the broadcast + recipient rows and enqueues a
      // durable dispatch job (delayed when scheduled). No inline sending —
      // the worker fans out; the detail page polls for progress.
      setProgress(75);
      const res = await fetch('/api/whatsapp/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: payload.name,
          recipients,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          ...(payload.channelId ? { channel_id: payload.channelId } : {}),
          ...(payload.scheduledAt ? { scheduled_at: payload.scheduledAt } : {}),
        }),
      });

      const data = (await res.json().catch(() => null)) as {
        broadcast_id?: string;
        error?: string;
      } | null;

      if (!res.ok || !data?.broadcast_id) {
        throw new Error(data?.error || 'Failed to enqueue broadcast');
      }

      setProgress(100);
      return data.broadcast_id;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
