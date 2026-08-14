// ============================================================
// /api/ai/credentials — chaves de API reutilizáveis (Fase 1).
//
//   GET  — lista as credenciais da conta (mascaradas). Qualquer membro.
//   POST — cria uma credencial (valida a chave antes de salvar). Admin+.
//
// A chave em claro NUNCA é retornada — só uma dica mascarada.
// ============================================================

import { NextResponse } from "next/server";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { AiError, type AiProvider } from "@/lib/ai/types";
import {
  listCredentials,
  createCredential,
  CredentialError,
} from "@/lib/ai/credentials";

export async function GET() {
  try {
    const { accountId } = await getCurrentAccount();
    const credentials = await listCredentials(accountId);
    return NextResponse.json({ credentials });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole("admin");

    const limit = await checkRateLimit(
      `ai:credentialCreate:${userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Corpo da requisição deve ser um objeto JSON." },
        { status: 400 },
      );
    }

    const provider = body.provider as AiProvider;
    if (provider !== "openai" && provider !== "anthropic") {
      return NextResponse.json(
        { error: 'provider deve ser "openai" ou "anthropic".' },
        { status: 400 },
      );
    }
    const label = typeof body.label === "string" ? body.label : "";
    const apiKey = typeof body.api_key === "string" ? body.api_key : "";

    try {
      const credential = await createCredential({
        accountId,
        userId,
        provider,
        label,
        apiKey,
      });
      return NextResponse.json({ credential }, { status: 201 });
    } catch (err) {
      if (err instanceof AiError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: 400 },
        );
      }
      if (err instanceof CredentialError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
