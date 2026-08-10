// ============================================================
// GET  /api/v1/deals  — list deals (Kanban cards). scope: deals:read
// POST /api/v1/deals  — create a deal (card).       scope: deals:write
//
// List is keyset-paginated (created_at desc, id desc) and supports
// `?pipeline_id=`, `?stage_id=`, `?contact_id=`, `?status=` filters.
// Create defaults pipeline/stage to the account's first when omitted, so
// an agent can drop a card into the board with just a title.
// ============================================================

import { and, desc, eq, lt, or, sql } from 'drizzle-orm';

import { db, deals, contacts, customFields, contactCustomValues } from '@/db';
import { firstOrNull, firstOrThrow } from '@/db/helpers';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, buildPage } from '@/lib/api/v1/pagination';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import {
  DEAL_COLUMNS,
  serializeDeal,
  getDealById,
  assertPipelineOwned,
  assertStageInPipeline,
  firstPipelineOf,
  firstStageOf,
  DealError,
} from '@/lib/api/v1/deals';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'deals:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);

    const conditions = [eq(deals.accountId, ctx.accountId)];
    const pipelineId = url.searchParams.get('pipeline_id');
    const stageId = url.searchParams.get('stage_id');
    const contactId = url.searchParams.get('contact_id');
    const status = url.searchParams.get('status');
    if (pipelineId) conditions.push(eq(deals.pipelineId, pipelineId));
    if (stageId) conditions.push(eq(deals.stageId, stageId));
    if (contactId) conditions.push(eq(deals.contactId, contactId));
    if (status) conditions.push(eq(deals.status, status));

    if (cursor) {
      conditions.push(
        or(
          lt(deals.createdAt, cursor.createdAt),
          and(eq(deals.createdAt, cursor.createdAt), lt(deals.id, cursor.id)),
        )!,
      );
    }

    let rows: Array<Record<string, unknown> & { created_at: string; id: string }>;
    try {
      rows = (await db
        .select(DEAL_COLUMNS)
        .from(deals)
        .where(and(...conditions))
        .orderBy(desc(deals.createdAt), desc(deals.id))
        .limit(limit + 1)) as never;
    } catch (error) {
      console.error('[api/v1/deals] list error:', error);
      return fail('internal', 'Failed to list deals', 500);
    }

    const { items, nextCursor } = buildPage(rows, limit);
    return okList(
      items.map((r) => serializeDeal(r as Record<string, unknown>)),
      nextCursor,
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'deals:write');
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return fail('bad_request', "'title' is required", 400);

    // Resolve pipeline: explicit (must be owned) or the account's first.
    let pipelineId =
      typeof body.pipeline_id === 'string' ? body.pipeline_id : null;
    if (pipelineId) {
      await assertPipelineOwned(ctx.accountId, pipelineId);
    } else {
      pipelineId = await firstPipelineOf(ctx.accountId);
      if (!pipelineId) {
        return fail(
          'bad_request',
          'No pipeline exists — create one in the dashboard or pass pipeline_id',
          400,
        );
      }
    }

    // Resolve stage: explicit (must belong to the pipeline) or its first.
    let stageId = typeof body.stage_id === 'string' ? body.stage_id : null;
    if (stageId) {
      await assertStageInPipeline(pipelineId, stageId);
    } else {
      stageId = await firstStageOf(pipelineId);
      if (!stageId) {
        return fail('bad_request', 'The pipeline has no stages', 400);
      }
    }

    // Optional contact — must belong to the account when given.
    let contactId: string | null = null;
    if (typeof body.contact_id === 'string' && body.contact_id) {
      const owned = firstOrNull(
        await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.id, body.contact_id),
              eq(contacts.accountId, ctx.accountId),
            ),
          )
          .limit(1),
      );
      if (!owned) return fail('bad_request', 'contact_id not found', 400);
      contactId = body.contact_id;
    }

    const userId = await resolveAuditUserId(ctx.accountId);
    const inserted = firstOrNull(
      await db
        .insert(deals)
        .values({
          userId,
          accountId: ctx.accountId,
          pipelineId,
          stageId,
          contactId,
          title,
          value:
            body.value != null && !Number.isNaN(Number(body.value))
              ? String(Number(body.value))
              : '0',
          currency:
            typeof body.currency === 'string' ? body.currency : undefined,
          notes: typeof body.notes === 'string' ? body.notes : null,
          status: typeof body.status === 'string' ? body.status : undefined,
          // Fonte/Origem (ex.: source="site", origin="diagnostico") — antes eram
          // descartados; agora viram campos de verdade no negócio, não vão pro notes.
          source: typeof body.source === 'string' ? body.source : null,
          origin: typeof body.origin === 'string' ? body.origin : null,
          temperature:
            typeof body.temperature === 'string' ? body.temperature : null,
          qualification:
            body.qualification != null &&
            !Number.isNaN(Number(body.qualification))
              ? Math.max(1, Math.min(5, Math.round(Number(body.qualification))))
              : null,
          expectedCloseDate:
            typeof body.expected_close_date === 'string'
              ? body.expected_close_date
              : null,
        })
        .returning({ id: deals.id }),
    );

    // Campos personalizados (opcional): { "Faturamento": "R$ 500 mil", ... }.
    // Cada chave vira um campo personalizado (find-or-create por nome) e o valor
    // é salvo no CONTATO do negócio → aparece ESTRUTURADO no detalhe (não no notes).
    if (
      contactId &&
      body.custom_fields &&
      typeof body.custom_fields === 'object' &&
      !Array.isArray(body.custom_fields)
    ) {
      await applyDealCustomFields(
        ctx.accountId,
        userId,
        contactId,
        body.custom_fields as Record<string, unknown>,
      );
    }

    const deal = await getDealById(ctx.accountId, inserted!.id);
    return ok(deal, 201);
  } catch (err) {
    if (err instanceof DealError) {
      return fail(err.status === 400 ? 'bad_request' : 'not_found', err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}

/** Salva pares {nome: valor} como campos personalizados no CONTATO do negócio
 *  (find-or-create do campo por nome; upsert do valor). Best-effort — uma falha
 *  num campo não derruba a criação do negócio. */
async function applyDealCustomFields(
  accountId: string,
  userId: string,
  contactId: string,
  cf: Record<string, unknown>,
): Promise<void> {
  for (const [rawName, rawVal] of Object.entries(cf)) {
    const name = String(rawName).trim();
    const value = Array.isArray(rawVal)
      ? rawVal.filter((v) => v != null && String(v).trim()).join(', ')
      : rawVal == null
        ? ''
        : String(rawVal).trim();
    if (!name || !value) continue;
    try {
      const field = firstOrNull(
        await db
          .select({ id: customFields.id })
          .from(customFields)
          .where(
            and(
              eq(customFields.accountId, accountId),
              sql`lower(${customFields.fieldName}) = lower(${name})`,
            ),
          )
          .limit(1),
      );
      let fieldId = field?.id;
      if (!fieldId) {
        const created = firstOrThrow(
          await db
            .insert(customFields)
            .values({ userId, accountId, fieldName: name, fieldType: 'text' })
            .returning({ id: customFields.id }),
        );
        fieldId = created.id;
      }
      await db
        .insert(contactCustomValues)
        .values({ contactId, customFieldId: fieldId, value })
        .onConflictDoUpdate({
          target: [
            contactCustomValues.contactId,
            contactCustomValues.customFieldId,
          ],
          set: { value },
        });
    } catch (err) {
      console.error('[api/v1/deals] custom field failed:', name, err);
    }
  }
}
