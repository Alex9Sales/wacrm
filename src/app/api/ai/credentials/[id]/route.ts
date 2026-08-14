// ============================================================
// DELETE /api/ai/credentials/[id] — remove uma credencial. Admin+.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { deleteCredential } from "@/lib/ai/credentials";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { accountId } = await requireRole("admin");
    const { id } = await params;
    const removed = await deleteCredential(accountId, id);
    if (!removed) {
      return NextResponse.json(
        { error: "Credencial não encontrada." },
        { status: 404 },
      );
    }
    return NextResponse.json({ id, deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
