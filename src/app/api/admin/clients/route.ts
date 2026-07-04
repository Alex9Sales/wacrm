// ============================================================
// POST /api/admin/clients — provision a new client (Phase 8).
//
// Platform-admin only (requirePlatformAdmin). Alex creates the client's
// login (email + initial password) and hands it over; the client
// changes it later. Flow:
//   1. Create the owner user WITH the given password via Better Auth
//      (auth.api.signUpEmail) — this hashes the password into a
//      credential account row.
//   2. Direct-insert the organization (unique derived slug) + an owner
//      `member` row + the `organization_billing` satellite. Direct
//      inserts are more reliable server-side than driving the org
//      plugin as the freshly-created user.
//
// Returns the org id + owner email + the temp password so the UI can
// show Alex the credentials to hand over. Duplicate email → 409.
// ============================================================

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, organization, member, organizationBilling, user } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { auth } from "@/lib/auth";
import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { listClients, getClientOverview } from "@/lib/admin/clients";

/**
 * GET /api/admin/clients — every org + billing + owner + counts, plus the
 * status overview counters in one round-trip for the /admin dashboard.
 * Platform-admin only.
 */
export async function GET() {
  try {
    await requirePlatformAdmin();
    const [clients, overview] = await Promise.all([
      listClients(),
      getClientOverview(),
    ]);
    return NextResponse.json({ clients, overview });
  } catch (err) {
    return toErrorResponse(err);
  }
}

// `toErrorResponse` (account.ts) handles the shared Unauthorized /
// Forbidden / AccountSuspended errors thrown by the platform gate.

/**
 * Derive a friendly, reasonably-unique slug from an org name — mirrors
 * the signup page's deriveSlug (normalize accents, hyphenate, random
 * suffix to avoid collisions between same-named workspaces).
 */
function deriveSlug(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const suffix = Math.random().toString(36).slice(2, 8);
  return base ? `${base}-${suffix}` : `workspace-${suffix}`;
}

interface ProvisionBody {
  orgName?: unknown;
  ownerName?: unknown;
  ownerEmail?: unknown;
  password?: unknown;
  plan?: unknown;
  dueAt?: unknown;
  billingPhone?: unknown;
}

function asTrimmedString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export async function POST(request: Request) {
  try {
    // Gate: platform admin only. Throws Unauthorized/Forbidden.
    await requirePlatformAdmin();

    const body = (await request.json().catch(() => ({}))) as ProvisionBody;

    const orgName = asTrimmedString(body.orgName);
    const ownerName = asTrimmedString(body.ownerName);
    const ownerEmail = asTrimmedString(body.ownerEmail)?.toLowerCase() ?? null;
    const password =
      typeof body.password === "string" && body.password.length > 0
        ? body.password
        : null;
    const plan = asTrimmedString(body.plan);
    const billingPhone = asTrimmedString(body.billingPhone);
    const dueAtRaw = asTrimmedString(body.dueAt);

    if (!orgName || !ownerName || !ownerEmail || !password) {
      return NextResponse.json(
        {
          error:
            "orgName, ownerName, ownerEmail e password são obrigatórios.",
        },
        { status: 400 },
      );
    }

    // Parse/validate dueAt if provided (ISO string / date). Invalid → 400.
    let dueAt: string | null = null;
    if (dueAtRaw) {
      const d = new Date(dueAtRaw);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json(
          { error: "dueAt inválido (use uma data ISO)." },
          { status: 400 },
        );
      }
      dueAt = d.toISOString();
    }

    // Pre-check for an existing user to return a clean 409 (signUpEmail
    // also guards this, but its thrown shape is provider-specific).
    const existing = firstOrNull(
      await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, ownerEmail))
        .limit(1),
    );
    if (existing) {
      return NextResponse.json(
        { error: "Já existe um usuário com esse e-mail." },
        { status: 409 },
      );
    }

    // 1. Create the owner user + hashed credential via Better Auth.
    let newUserId: string;
    try {
      const res = await auth.api.signUpEmail({
        body: { name: ownerName, email: ownerEmail, password },
      });
      newUserId = res.user.id;
    } catch (err) {
      // Better Auth throws APIError on duplicate email / weak password.
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "";
      if (/exist|taken|unique|duplicate/i.test(message)) {
        return NextResponse.json(
          { error: "Já existe um usuário com esse e-mail." },
          { status: 409 },
        );
      }
      console.error("[POST /api/admin/clients] signUpEmail failed:", err);
      return NextResponse.json(
        { error: "Não foi possível criar o usuário do cliente." },
        { status: 400 },
      );
    }

    // 2. Create org + owner member + billing (direct inserts).
    const [org] = await db
      .insert(organization)
      .values({ name: orgName, slug: deriveSlug(orgName) })
      .returning({ id: organization.id });

    await db.insert(member).values({
      userId: newUserId,
      organizationId: org.id,
      role: "owner",
    });

    await db.insert(organizationBilling).values({
      organizationId: org.id,
      status: "active",
      startedAt: new Date().toISOString(),
      dueAt,
      plan,
      billingPhone,
    });

    return NextResponse.json(
      {
        id: org.id,
        owner: { email: ownerEmail },
        tempPassword: password,
      },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
