// ============================================================
// GET  /api/v1/conversations/{id}/tags — tags on this thread's contact
//                                         (scope: tags:read)
// POST /api/v1/conversations/{id}/tags — add a tag to the thread's contact
//                                         (scope: tags:write)
//
// Tags live on the contact, but Hermes / n8n think in conversations —
// "flag THIS thread as 'pago'". POST accepts either an existing
// { tag_id }, or a { name } (created if it doesn't exist yet, so the AI
// can label freely). Returns the contact's full tag set after the change.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import {
  contactIdForConversation,
  listContactTags,
  addTagToContact,
  createOrGetTag,
  tagBelongsToAccount,
} from '@/lib/api/v1/tags';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'tags:read');
    const { id } = await params;
    const contactId = await contactIdForConversation(ctx.accountId, id);
    if (!contactId) return fail('not_found', 'Conversation not found', 404);
    return okList(await listContactTags(contactId), null);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'tags:write');
    const { id } = await params;

    const contactId = await contactIdForConversation(ctx.accountId, id);
    if (!contactId) return fail('not_found', 'Conversation not found', 404);

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    let tagId: string;
    if (typeof body.tag_id === 'string' && body.tag_id) {
      if (!(await tagBelongsToAccount(ctx.accountId, body.tag_id))) {
        return fail('invalid_request', 'tag_id not found in this account', 422);
      }
      tagId = body.tag_id;
    } else if (typeof body.name === 'string' && body.name.trim()) {
      const auditUserId = await resolveAuditUserId(ctx.accountId);
      const color =
        typeof body.color === 'string' && body.color.trim()
          ? body.color.trim()
          : undefined;
      const { tag } = await createOrGetTag(ctx.accountId, auditUserId, {
        name: body.name,
        color,
      });
      tagId = tag.id;
    } else {
      return fail('invalid_request', "Provide 'tag_id' or 'name'", 422);
    }

    await addTagToContact(contactId, tagId);
    return ok(await listContactTags(contactId));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
