// ============================================================
// GET /api/v1/conversations/{id} — read one conversation
// (scope: conversations:read). Account-scoped: a foreign id → 404.
// ============================================================

import { and, eq } from 'drizzle-orm';

import { db, contacts, conversations, member, sectors } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { loadTagsByContact } from '@/lib/api/v1/contacts';
import { serializeConversation } from '@/lib/api/v1/conversations';
import type { Conversation } from '@/types';

/** The column shape GET serializes — shared by GET and PATCH's reload. */
const CONVERSATION_COLUMNS = {
  id: conversations.id,
  contact_id: conversations.contactId,
  status: conversations.status,
  priority: conversations.priority,
  assigned_agent_id: conversations.assignedAgentId,
  last_message_text: conversations.lastMessageText,
  last_message_at: conversations.lastMessageAt,
  unread_count: conversations.unreadCount,
  created_at: conversations.createdAt,
  updated_at: conversations.updatedAt,
  contact: {
    id: contacts.id,
    phone: contacts.phone,
    name: contacts.name,
    email: contacts.email,
    company: contacts.company,
    is_group: contacts.isGroup,
  },
} as const;

async function loadAndSerialize(id: string, accountId: string) {
  const row = firstOrNull(
    await db
      .select(CONVERSATION_COLUMNS)
      .from(conversations)
      .leftJoin(contacts, eq(conversations.contactId, contacts.id))
      .where(
        and(eq(conversations.id, id), eq(conversations.accountId, accountId)),
      )
      .limit(1),
  );
  if (!row) return null;
  const tagsByContact = await loadTagsByContact(
    row.contact ? [row.contact.id] : [],
  );
  return serializeConversation({
    ...row,
    contact: row.contact
      ? { ...row.contact, tags: tagsByContact.get(row.contact.id) ?? [] }
      : null,
  } as unknown as Conversation);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { id } = await params;

    let serialized;
    try {
      serialized = await loadAndSerialize(id, ctx.accountId);
    } catch (error) {
      console.error('[api/v1/conversations] read error:', error);
      return fail('internal', 'Failed to read conversation', 500);
    }
    if (!serialized) return fail('not_found', 'Conversation not found', 404);
    return ok(serialized);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

// ============================================================
// PATCH /api/v1/conversations/{id} — transfer / assign a conversation
// (scope: conversations:write). Reassigning is just changing the owner of the
// SAME thread — the full history stays intact for whoever picks it up. Body
// accepts any of: assigned_agent_id (member id | null to unassign), sector_id
// (sector id | null for the general queue), status (open|pending|closed),
// priority (none|low|medium|high|urgent — so Hermes/n8n can flag urgency).
// ============================================================
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:write');
    const { id } = await params;

    const existing = firstOrNull(
      await db
        .select({ id: conversations.id, status: conversations.status })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, id),
            eq(conversations.accountId, ctx.accountId)
          )
        )
        .limit(1)
    );
    if (!existing) return fail('not_found', 'Conversation not found', 404);

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const patch: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    let changed = false;

    if ('assigned_agent_id' in body) {
      const v = body.assigned_agent_id;
      if (v === null) {
        patch.assignedAgentId = null;
      } else if (typeof v === 'string' && v) {
        const isMember = firstOrNull(
          await db
            .select({ userId: member.userId })
            .from(member)
            .where(
              and(
                eq(member.organizationId, ctx.accountId),
                eq(member.userId, v)
              )
            )
            .limit(1)
        );
        if (!isMember) {
          return fail(
            'invalid_request',
            'assigned_agent_id is not a member of this account',
            422
          );
        }
        patch.assignedAgentId = v;
        patch.assignedAt = new Date().toISOString();
      } else {
        return fail(
          'invalid_request',
          'assigned_agent_id must be a member id or null',
          422
        );
      }
      changed = true;
    }

    if ('sector_id' in body) {
      const v = body.sector_id;
      if (v === null) {
        patch.sectorId = null;
      } else if (typeof v === 'string' && v) {
        const sector = firstOrNull(
          await db
            .select({ id: sectors.id })
            .from(sectors)
            .where(and(eq(sectors.id, v), eq(sectors.accountId, ctx.accountId)))
            .limit(1)
        );
        if (!sector) {
          return fail(
            'invalid_request',
            'sector_id not found in this account',
            422
          );
        }
        patch.sectorId = v;
      } else {
        return fail(
          'invalid_request',
          'sector_id must be a sector id or null',
          422
        );
      }
      changed = true;
    }

    if ('status' in body) {
      const v = body.status;
      if (v !== 'open' && v !== 'pending' && v !== 'closed') {
        return fail(
          'invalid_request',
          "status must be one of 'open', 'pending', 'closed'",
          422
        );
      }
      patch.status = v;
      changed = true;
    }

    if ('priority' in body) {
      const v = body.priority;
      const allowed = ['none', 'low', 'medium', 'high', 'urgent'];
      if (typeof v !== 'string' || !allowed.includes(v)) {
        return fail(
          'invalid_request',
          "priority must be one of 'none', 'low', 'medium', 'high', 'urgent'",
          422
        );
      }
      patch.priority = v;
      changed = true;
    }

    if (!changed) {
      return fail(
        'invalid_request',
        'Provide at least one of assigned_agent_id, sector_id, status, priority',
        422
      );
    }

    try {
      await db
        .update(conversations)
        .set(patch)
        .where(
          and(
            eq(conversations.id, id),
            eq(conversations.accountId, ctx.accountId)
          )
        );
    } catch (error) {
      console.error('[api/v1/conversations] patch error:', error);
      return fail('internal', 'Failed to update conversation', 500);
    }

    // Closing (open→closed) triggers the CSAT survey when enabled.
    if (body.status === 'closed' && existing.status !== 'closed') {
      const { sendCsatSurveyIfEnabled } = await import('@/lib/csat/csat');
      await sendCsatSurveyIfEnabled(ctx.accountId, id);
    }

    const serialized = await loadAndSerialize(id, ctx.accountId);
    if (!serialized) return fail('not_found', 'Conversation not found', 404);
    return ok(serialized);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
