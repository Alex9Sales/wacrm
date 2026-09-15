// ============================================================
// GET /api/v1/broadcasts/{id} — broadcast status + counts
// (scope: broadcasts:send).
//
// Poll this after POST /api/v1/broadcasts to watch the fan-out
// progress. `status` moves 'sending' → 'sent'; the delivered/read
// counts continue to climb as Meta delivery webhooks arrive.
// Account-scoped: a foreign id → 404.
//
// DELETE /api/v1/broadcasts/{id} — mesma regra da tela (15/09, GoLink: o
// "dia do cliente" foi excluído depois de sair e levou o histórico junto):
//   - só quando quem criou a chave criou o disparo ou é supervisor+;
//   - ativo é cancelado antes;
//   - já saiu pra alguém → ARQUIVA (histórico fica); nunca saiu → apaga.
// Response (200): { "data": { "id", "archived": boolean } }
// ============================================================

import { and, eq } from 'drizzle-orm';

import { db, broadcasts } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { deleteOrArchiveBroadcast, memberRole } from '@/lib/queue/broadcast-controls';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');
    const { id } = await params;

    let data;
    try {
      data = firstOrNull(
        await db
          .select({
            id: broadcasts.id,
            name: broadcasts.name,
            template_name: broadcasts.templateName,
            template_language: broadcasts.templateLanguage,
            status: broadcasts.status,
            total_recipients: broadcasts.totalRecipients,
            sent_count: broadcasts.sentCount,
            delivered_count: broadcasts.deliveredCount,
            read_count: broadcasts.readCount,
            replied_count: broadcasts.repliedCount,
            failed_count: broadcasts.failedCount,
            // 15/09: por que está pausado ('manual' | 'reputation' | 'session') e se foi arquivado.
            paused_at: broadcasts.pausedAt,
            pause_reason: broadcasts.pauseReason,
            archived_at: broadcasts.archivedAt,
            created_at: broadcasts.createdAt,
            updated_at: broadcasts.updatedAt,
          })
          .from(broadcasts)
          .where(
            and(eq(broadcasts.id, id), eq(broadcasts.accountId, ctx.accountId))
          )
          .limit(1)
      );
    } catch (error) {
      console.error('[api/v1/broadcasts] read error:', error);
      return fail('internal', 'Failed to read broadcast', 500);
    }

    if (!data) return fail('not_found', 'Broadcast not found', 404);

    return ok(data);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');
    const { id } = await params;

    // A chave age como quem a criou, com o papel que essa pessoa tem HOJE.
    // O rastro (delete/archive em broadcast_events) é gravado lá dentro — a
    // exclusão real grava o evento ANTES de apagar (revisão 15/09).
    const role = await memberRole(ctx.accountId, ctx.createdBy);
    const result = await deleteOrArchiveBroadcast(id, ctx.accountId, {
      userId: role ? ctx.createdBy : null,
      role,
      audit: { userId: ctx.createdBy, role: 'api_key', extra: { keyId: ctx.keyId } },
    });
    if (!result.ok) {
      if (result.code === 'not_found') return fail('not_found', 'Broadcast not found', 404);
      return fail('forbidden', result.error, 403);
    }
    return ok({ id, archived: result.archived });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
