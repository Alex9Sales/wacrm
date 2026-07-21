// ============================================================
// GET  /api/v1/contacts  — list contacts (scope: contacts:read)
// POST /api/v1/contacts  — create a contact  (scope: contacts:write)
//
// List is keyset-paginated (see src/lib/api/v1/pagination.ts) and
// supports `?search=` (name/phone) and `?tag=<tagId>` filters. Create
// is find-or-create by phone: an existing match returns 200 with
// `created: false`; a new row returns 201 with `created: true`.
// ============================================================

import { and, desc, eq, ilike, lt, or } from 'drizzle-orm';

import { db, contactTags, contacts } from '@/db';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, buildPage } from '@/lib/api/v1/pagination';
import {
  serializeContact,
  loadTagsByContact,
  findOrCreateContact,
  setContactTags,
  getContactById,
  resolveAuditUserId,
  ContactError,
} from '@/lib/api/v1/contacts';

// Strip anything that isn't a character a phone or name legitimately
// contains before it reaches the ILIKE patterns.
function sanitizeSearch(raw: string): string {
  return raw.replace(/[^\p{L}\p{N} +@.\-_]/gu, '').trim();
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const search = sanitizeSearch(url.searchParams.get('search') ?? '');
    const tag = url.searchParams.get('tag');
    const phone = url.searchParams.get('phone');

    const conditions = [eq(contacts.accountId, ctx.accountId)];

    // ?phone=<numero> → busca EXATA pelo número (dígitos normalizados).
    if (phone) {
      conditions.push(eq(contacts.phoneNormalized, normalizePhone(phone)));
    }

    if (search) {
      conditions.push(
        or(
          ilike(contacts.name, `%${search}%`),
          ilike(contacts.phone, `%${search}%`)
        )!
      );
    }

    // Keyset filter — walk past the cursor row under the
    // (created_at desc, id desc) ordering.
    if (cursor) {
      conditions.push(
        or(
          lt(contacts.createdAt, cursor.createdAt),
          and(
            eq(contacts.createdAt, cursor.createdAt),
            lt(contacts.id, cursor.id)
          )
        )!
      );
    }

    const baseSelect = {
      id: contacts.id,
      phone: contacts.phone,
      name: contacts.name,
      email: contacts.email,
      company: contacts.company,
      avatar_url: contacts.avatarUrl,
      created_at: contacts.createdAt,
      updated_at: contacts.updatedAt,
    };

    // When filtering by tag, an INNER join on contact_tags keeps the
    // contact only if it has the tag — the join is bounded to that one
    // tag id, so it can't fan out rows. The contact's FULL tag set is
    // still loaded below for serialization. This filters in one bounded
    // query (paged by limit+1) instead of pre-fetching an unbounded id
    // list into an `inArray(...)`.
    let rows: Array<Record<string, unknown> & { created_at: string | null; id: string }>;
    try {
      const query = tag
        ? db
            .select(baseSelect)
            .from(contacts)
            .innerJoin(
              contactTags,
              and(
                eq(contactTags.contactId, contacts.id),
                eq(contactTags.tagId, tag)
              )
            )
        : db.select(baseSelect).from(contacts);

      rows = await query
        .where(and(...conditions))
        .orderBy(desc(contacts.createdAt), desc(contacts.id))
        .limit(limit + 1);
    } catch (error) {
      console.error('[api/v1/contacts] list error:', error);
      return fail('internal', 'Failed to list contacts', 500);
    }

    const { items, nextCursor } = buildPage(
      rows as unknown as Array<{ created_at: string; id: string }>,
      limit
    );

    const tagsByContact = await loadTagsByContact(items.map((r) => r.id));

    return okList(
      items.map((r) =>
        serializeContact({
          ...r,
          contact_tags: (tagsByContact.get(r.id) ?? []).map((t) => ({
            tags: t,
          })),
        })
      ),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!phone) {
      return fail('bad_request', "'phone' is required", 400);
    }

    const auditUserId = await resolveAuditUserId(ctx.accountId);

    const { id, created } = await findOrCreateContact(
      ctx.accountId,
      auditUserId,
      {
        phone,
        name: typeof body.name === 'string' ? body.name : undefined,
        email: typeof body.email === 'string' ? body.email : undefined,
        company: typeof body.company === 'string' ? body.company : undefined,
      }
    );

    if (Array.isArray(body.tags)) {
      await setContactTags(
        ctx.accountId,
        auditUserId,
        id,
        body.tags.filter((t): t is string => typeof t === 'string')
      );
    }

    const contact = await getContactById(ctx.accountId, id);
    return ok(contact, created ? 201 : 200);
  } catch (err) {
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
