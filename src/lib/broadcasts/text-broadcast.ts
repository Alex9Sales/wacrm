// ============================================================
// Text-broadcast core — the account-scoped engine behind both the
// dashboard "Disparo de texto" action AND the public API
// (POST /api/v1/broadcasts/text). Session-independent: callers pass
// accountId + userId (the dashboard resolves them from the session, the
// API from the key context).
//
// Given already-resolved recipient contact ids, it validates the channel
// (must be a non-official provider), computes each recipient's send slot
// (humanized drip or spaced "send now"), persists the broadcast +
// recipient rows, and enqueues the dispatch. `upsertContactsByPhone` is the
// helper the API uses to turn a CSV-style {phone,name}[] into owned contact
// ids before calling in.
// ============================================================

import { and, eq, inArray } from 'drizzle-orm'

import { db, broadcasts, broadcastRecipients, contacts } from '@/db'
import { firstOrThrow } from '@/db/helpers'
import { loadChannel } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import { enqueueBroadcastDispatch } from '@/lib/queue/queues'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import {
  computeDripSlots,
  normalizePacing,
  nowSpacedSlots,
  type PacingConfig,
} from '@/lib/whatsapp/drip-schedule'

export interface EnqueueTextBroadcastInput {
  name?: string | null
  channelId: string
  bodyText: string
  mediaUrl?: string | null
  mediaType?: 'image' | 'video' | 'document' | 'audio' | null
  mediaFilename?: string | null
  /** Max sends per day (default 50) for the humanized drip. */
  dailyCap?: number
  /** Start now, ignoring business hours (test / urgent). */
  sendNow?: boolean
  /** When sendNow: minutes between each message (0 = all at once). */
  sendNowIntervalMin?: number
  /** Already-resolved, account-owned contact ids to send to. */
  recipientContactIds: string[]
  /** Stored on the broadcast row for auditing (what the caller asked for). */
  audienceFilter?: unknown
}

export interface EnqueueTextBroadcastResult {
  broadcastId: string | null
  totalRecipients: number
  error: string | null
}

/**
 * Validate + persist + enqueue a humanized text broadcast. Recipient contact
 * ids MUST already be account-owned (the caller resolves the audience). Only
 * contacts with a valid E.164 phone are kept.
 */
export async function enqueueTextBroadcast(
  accountId: string,
  userId: string,
  input: EnqueueTextBroadcastInput,
): Promise<EnqueueTextBroadcastResult> {
  try {
    const body = (input.bodyText ?? '').trim()
    const mediaUrl = (input.mediaUrl ?? '').trim()
    if (!body && !mediaUrl) {
      return { broadcastId: null, totalRecipients: 0, error: 'Escreva a mensagem ou anexe uma mídia.' }
    }
    const mediaType = mediaUrl
      ? ((['image', 'video', 'document', 'audio'] as const).includes(
          input.mediaType as 'image',
        )
          ? input.mediaType
          : 'image')
      : null

    // Channel: owned + a non-official provider (text drip is WAHA/Evo/EvoGo).
    const channel = input.channelId ? await loadChannel(input.channelId) : null
    if (!channel || channel.accountId !== accountId) {
      return { broadcastId: null, totalRecipients: 0, error: 'Canal inválido.' }
    }
    if (!getProvider(channel.provider).capabilities.needsJitter) {
      return {
        broadcastId: null,
        totalRecipients: 0,
        error:
          'Disparo de texto só em canal não-oficial (WAHA/Evolution/EvoGo). Para o Meta use um template.',
      }
    }

    // Keep account-owned contacts with a valid phone, deduped, in order.
    const ids = Array.from(
      new Set(input.recipientContactIds.filter((v): v is string => !!v)),
    )
    const recipients: { contactId: string }[] = []
    if (ids.length > 0) {
      const rows = (await db
        .select({ id: contacts.id, phone: contacts.phone })
        .from(contacts)
        .where(and(inArray(contacts.id, ids), eq(contacts.accountId, accountId)))) as {
        id: string
        phone: string | null
      }[]
      const byId = new Map(rows.map((r) => [r.id, r]))
      for (const id of ids) {
        const c = byId.get(id)
        if (!c) continue
        const sanitized = sanitizePhoneForMeta(c.phone ?? '')
        if (!isValidE164(sanitized)) continue
        recipients.push({ contactId: c.id })
      }
    }
    if (recipients.length === 0) {
      return {
        broadcastId: null,
        totalRecipients: 0,
        error: 'Nenhum contato com telefone válido nesta audiência.',
      }
    }

    // "Enviar agora" spacing vs humanized drip.
    const sendNow = !!input.sendNow
    const pacing: PacingConfig | null = sendNow
      ? null
      : normalizePacing({ dailyCap: input.dailyCap })
    let slots: number[]
    if (sendNow) {
      const intervalMin = Math.max(
        0,
        Math.min(1440, Math.floor(Number(input.sendNowIntervalMin ?? 0)) || 0),
      )
      slots = nowSpacedSlots(recipients.length, intervalMin * 60_000, Date.now())
    } else {
      slots = computeDripSlots(recipients.length, pacing!, Date.now())
    }

    const broadcast = firstOrThrow(
      await db
        .insert(broadcasts)
        .values({
          userId,
          accountId,
          name: input.name?.trim() || `Disparo de texto (${recipients.length})`,
          channelId: channel.id,
          messageKind: 'text',
          bodyText: body || null,
          mediaUrl: mediaUrl || null,
          mediaType,
          mediaFilename: input.mediaFilename?.trim() || null,
          pacing: pacing ? (pacing as unknown as Record<string, unknown>) : null,
          audienceFilter:
            input.audienceFilter != null
              ? (input.audienceFilter as Record<string, unknown>)
              : null,
          status: 'sending',
          totalRecipients: recipients.length,
          sentCount: 0,
          deliveredCount: 0,
          readCount: 0,
          repliedCount: 0,
          failedCount: 0,
        })
        .returning({ id: broadcasts.id }),
    )

    const rows = recipients.map((r, i) => ({
      broadcastId: broadcast.id,
      contactId: r.contactId,
      status: 'pending' as const,
      scheduledSlotAt: slots[i] ? new Date(slots[i]).toISOString() : null,
    }))
    const BATCH = 200
    try {
      for (let i = 0; i < rows.length; i += BATCH) {
        await db.insert(broadcastRecipients).values(rows.slice(i, i + BATCH))
      }
    } catch (recipErr) {
      await db
        .update(broadcasts)
        .set({ status: 'failed', failedCount: recipients.length })
        .where(eq(broadcasts.id, broadcast.id))
      throw recipErr
    }

    await enqueueBroadcastDispatch(broadcast.id)
    return { broadcastId: broadcast.id, totalRecipients: recipients.length, error: null }
  } catch (err) {
    console.error('[text-broadcast] enqueue failed:', err)
    return {
      broadcastId: null,
      totalRecipients: 0,
      error: err instanceof Error ? err.message : 'Falha ao criar o disparo.',
    }
  }
}

/**
 * Turn CSV-style {phone,name}[] into account-owned contact ids: find each
 * phone, insert the missing ones, return ids in input order (deduped).
 */
export async function upsertContactsByPhone(
  accountId: string,
  userId: string,
  rows: { phone: string; name?: string | null }[],
): Promise<string[]> {
  const uniqueByPhone = new Map<string, { phone: string; name?: string | null }>()
  for (const r of rows) {
    const phone = typeof r.phone === 'string' ? r.phone.trim() : ''
    if (phone) uniqueByPhone.set(phone, { phone, name: r.name })
  }
  const phones = [...uniqueByPhone.keys()]
  if (phones.length === 0) return []

  const existing = (await db
    .select({ id: contacts.id, phone: contacts.phone })
    .from(contacts)
    .where(and(eq(contacts.accountId, accountId), inArray(contacts.phone, phones)))) as {
    id: string
    phone: string | null
  }[]
  const byPhone = new Map<string, string>()
  for (const c of existing) if (c.phone) byPhone.set(c.phone, c.id)

  const missing = phones
    .filter((p) => !byPhone.has(p))
    .map((phone) => ({
      userId,
      accountId,
      phone,
      name: uniqueByPhone.get(phone)?.name ?? null,
    }))
  if (missing.length > 0) {
    const inserted = (await db
      .insert(contacts)
      .values(missing)
      .returning({ id: contacts.id, phone: contacts.phone })) as {
      id: string
      phone: string | null
    }[]
    for (const c of inserted) if (c.phone) byPhone.set(c.phone, c.id)
  }

  return phones
    .map((p) => byPhone.get(p))
    .filter((id): id is string => !!id)
}
