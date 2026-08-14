// ============================================================
// POST /api/ai/credentials/import — importa as chaves que já estão nos
// agentes para o registro de credenciais (deduplicando pela chave real).
// Admin+. Devolve quantas foram criadas.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { importCredentialsFromAgents } from "@/lib/ai/credentials";

export async function POST() {
  try {
    const { accountId, userId } = await requireRole("admin");
    const created = await importCredentialsFromAgents({ accountId, userId });
    return NextResponse.json({ created });
  } catch (err) {
    return toErrorResponse(err);
  }
}
