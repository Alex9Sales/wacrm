// ============================================================
// GET  /api/v1/tags — list the account's tags       (scope: tags:read)
// POST /api/v1/tags — create a tag (idempotent)      (scope: tags:write)
//
// Tags are account-level labels. POST is create-or-get by name (case-
// insensitive) so an n8n "setup" workflow can (re)create the same set of
// labels without piling up duplicates. Body: { name, color? } — color is
// a hex string, defaulting to blue.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { listAccountTags, createOrGetTag } from '@/lib/api/v1/tags';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'tags:read');
    const tags = await listAccountTags(ctx.accountId);
    // Tag catalogs are small; return the whole set (no pagination).
    return okList(tags, null);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'tags:write');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return fail('invalid_request', "'name' is required", 422);
    }
    const color =
      typeof body.color === 'string' && body.color.trim()
        ? body.color.trim()
        : undefined;

    const auditUserId = await resolveAuditUserId(ctx.accountId);
    const { tag, created } = await createOrGetTag(ctx.accountId, auditUserId, {
      name,
      color,
    });
    return ok(tag, created ? 201 : 200);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
