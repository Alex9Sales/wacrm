// ============================================================
// DELETE /api/v1/conversations/{id}/tags/{tagId} — remove a tag from the
// thread's contact (scope: tags:write). Idempotent: removing a tag that
// isn't there still returns the current tag set. Returns the remaining tags.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  contactIdForConversation,
  listContactTags,
  removeTagFromContact,
} from '@/lib/api/v1/tags';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; tagId: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'tags:write');
    const { id, tagId } = await params;

    const contactId = await contactIdForConversation(ctx.accountId, id);
    if (!contactId) return fail('not_found', 'Conversation not found', 404);

    await removeTagFromContact(contactId, tagId);
    return ok(await listContactTags(contactId));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
