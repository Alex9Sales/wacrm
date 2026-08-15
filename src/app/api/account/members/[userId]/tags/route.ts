// ============================================================
// PUT /api/account/members/[userId]/tags — define as etiquetas de um atendente
// (Fase B — etiqueta no atendente). Admin+. Body: { tag_ids: string[] }.
// Substitui o conjunto. Só aceita etiquetas DA conta.
// ============================================================

import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { db, member, memberTags, tags } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const { accountId } = await requireRole("admin");
    const { userId } = await params;

    const body = (await request.json().catch(() => ({}))) as {
      tag_ids?: unknown;
    };
    const rawIds = Array.isArray(body.tag_ids) ? body.tag_ids : [];
    const wanted = rawIds.filter((x): x is string => typeof x === "string" && !!x);

    // O membro tem que ser da conta.
    const m = firstOrNull(
      await db
        .select({ id: member.id })
        .from(member)
        .where(
          and(eq(member.userId, userId), eq(member.organizationId, accountId)),
        )
        .limit(1),
    );
    if (!m) {
      return NextResponse.json({ error: "Membro não encontrado." }, { status: 404 });
    }

    // Só etiquetas DA conta.
    const validIds =
      wanted.length > 0
        ? (
            await db
              .select({ id: tags.id })
              .from(tags)
              .where(and(eq(tags.accountId, accountId), inArray(tags.id, wanted)))
          ).map((r) => r.id)
        : [];

    // Substitui o conjunto.
    await db.delete(memberTags).where(eq(memberTags.memberId, m.id));
    if (validIds.length > 0) {
      await db
        .insert(memberTags)
        .values(validIds.map((tagId) => ({ memberId: m.id, tagId })))
        .onConflictDoNothing();
    }

    return NextResponse.json({ ok: true, tag_ids: validIds });
  } catch (err) {
    return toErrorResponse(err);
  }
}
