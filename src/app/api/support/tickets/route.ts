// ============================================================
// /api/support/tickets — chamados de suporte abertos pelo cliente.
//
//   GET  — lista os chamados DESTA org (histórico na tela /suporte).
//   POST — abre um chamado: registra em support_tickets E dispara um
//          alerta no WhatsApp da Fluxia (texto + prints). Qualquer membro
//          autenticado pode abrir. O alerta é best-effort: se o WhatsApp
//          falhar, o chamado fica registrado mesmo assim (alerted_at null).
// ============================================================

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, supportTickets, user } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { normalizeSupportWhatsapp, isSupportTicketType, type SupportContext } from "@/lib/support/types";
import { listOrgTickets, serializeTicket } from "@/lib/support/queries";
import { sendSupportAlert } from "@/lib/support/alert";

const MAX_SUBJECT = 200;
const MAX_DESCRIPTION = 5000;
const MAX_SCREENSHOTS = 6;

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const tickets = await listOrgTickets(ctx.accountId);
    return NextResponse.json({ tickets });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Keep only http(s) string urls, de-duped, capped. */
function sanitizeScreenshots(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!/^https?:\/\//i.test(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_SCREENSHOTS) break;
  }
  return out;
}

/** Trim a client-provided context string to a sane length. */
function ctxStr(v: unknown, max = 400): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const limit = await checkRateLimit(
      `support:create:${ctx.userId}`,
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

    const type = isSupportTicketType(body.type) ? body.type : "problem";

    const subject =
      typeof body.subject === "string" ? body.subject.trim() : "";
    if (!subject) {
      return NextResponse.json(
        { error: "Informe um assunto para o chamado." },
        { status: 400 },
      );
    }

    const description =
      typeof body.description === "string"
        ? body.description.trim().slice(0, MAX_DESCRIPTION) || null
        : null;

    const screenshotUrls = sanitizeScreenshots(body.screenshot_urls);

    // WhatsApp do cliente — é por onde a gente responde quando resolve.
    const whatsapp = normalizeSupportWhatsapp(body.whatsapp);
    if (body.whatsapp && !whatsapp) {
      return NextResponse.json(
        { error: "WhatsApp inválido — use DDD + número (ex.: 67 99999-9999)." },
        { status: 400 },
      );
    }

    // Contexto do cliente (diagnóstico) — enriquecido com dados autoritativos.
    const rawCtx = (body.context ?? {}) as Record<string, unknown>;
    const authUser = firstOrNull(
      await db
        .select({ name: user.name, email: user.email })
        .from(user)
        .where(eq(user.id, ctx.userId))
        .limit(1),
    );
    const context: SupportContext = {
      url: ctxStr(rawCtx.url),
      userAgent: ctxStr(rawCtx.userAgent),
      language: ctxStr(rawCtx.language, 40),
      viewport: ctxStr(rawCtx.viewport, 40),
      referrer: ctxStr(rawCtx.referrer),
      orgName: ctx.account.name,
      userName: authUser?.name ?? undefined,
      userEmail: authUser?.email ?? undefined,
    };

    const inserted = firstOrNull(
      await db
        .insert(supportTickets)
        .values({
          accountId: ctx.accountId,
          createdBy: ctx.userId,
          type,
          subject: subject.slice(0, MAX_SUBJECT),
          description,
          screenshotUrls,
          context,
          whatsapp,
        })
        .returning(),
    );

    if (!inserted) {
      return NextResponse.json(
        { error: "Não foi possível registrar o chamado." },
        { status: 500 },
      );
    }

    // Dispara o alerta no WhatsApp da Fluxia (best-effort).
    const alert = await sendSupportAlert({
      ticketId: inserted.id,
      type,
      subject,
      description,
      screenshotUrls,
      context,
      whatsapp,
    });

    let row = inserted;
    if (alert.sent) {
      const now = new Date().toISOString();
      row =
        firstOrNull(
          await db
            .update(supportTickets)
            .set({ alertedAt: now, updatedAt: now })
            .where(eq(supportTickets.id, inserted.id))
            .returning(),
        ) ?? inserted;
    }

    return NextResponse.json(
      {
        ticket: serializeTicket(row),
        alerted: alert.sent,
        alert_error: alert.error ?? null,
      },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
