// ============================================================
// PATCH /api/admin/clients/[orgId] — update a client's billing (Phase 8).
//
// Platform-admin only (requirePlatformAdmin). Upserts the
// organization_billing satellite (creates the row when missing — legacy
// orgs predate the satellite). Body (all optional):
//   { status?, started_at?, due_at?, plan?, billing_phone?, notes? }
// - status validated against ('active','suspended','trial').
// - started_at / due_at: ISO strings (or null to clear); invalid → 400.
// Returns the updated billing row. Unknown org → 404.
// ============================================================

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db, organization, organizationBilling } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform";

const VALID_STATUS = new Set(["active", "suspended", "trial"]);

interface PatchBody {
  status?: unknown;
  started_at?: unknown;
  due_at?: unknown;
  plan?: unknown;
  billing_phone?: unknown;
  notes?: unknown;
}

/**
 * Normalize an optional text field. Returns:
 *   undefined → key absent, leave untouched.
 *   null      → explicit clear.
 *   string    → trimmed value (empty string clears → null).
 */
function optionalText(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Normalize an optional ISO-timestamp field. Same tri-state as
 * optionalText, but throws on an unparseable date so the caller can 400.
 */
function optionalTimestamp(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new Error("invalid-timestamp");
  }
  return d.toISOString();
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    await requirePlatformAdmin();
    const { orgId } = await params;

    const body = (await request.json().catch(() => ({}))) as PatchBody;

    // Validate status if present.
    let status: string | undefined;
    if (body.status !== undefined) {
      if (typeof body.status !== "string" || !VALID_STATUS.has(body.status)) {
        return NextResponse.json(
          { error: "status inválido (use 'active', 'suspended' ou 'trial')." },
          { status: 400 },
        );
      }
      status = body.status;
    }

    let startedAt: string | null | undefined;
    let dueAt: string | null | undefined;
    try {
      startedAt = optionalTimestamp(body.started_at);
      dueAt = optionalTimestamp(body.due_at);
    } catch {
      return NextResponse.json(
        { error: "started_at / due_at inválidos (use uma data ISO)." },
        { status: 400 },
      );
    }

    const plan = optionalText(body.plan);
    const billingPhone = optionalText(body.billing_phone);
    const notes = optionalText(body.notes);

    // Org must exist.
    const org = firstOrNull(
      await db
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, orgId))
        .limit(1),
    );
    if (!org) {
      return NextResponse.json(
        { error: "Organização não encontrada." },
        { status: 404 },
      );
    }

    // Upsert: build the set of fields the caller actually sent.
    const now = new Date().toISOString();
    const updates: Partial<typeof organizationBilling.$inferInsert> = {
      updatedAt: now,
    };
    if (status !== undefined) updates.status = status;
    if (startedAt !== undefined) updates.startedAt = startedAt;
    if (dueAt !== undefined) updates.dueAt = dueAt;
    if (plan !== undefined) updates.plan = plan;
    if (billingPhone !== undefined) updates.billingPhone = billingPhone;
    if (notes !== undefined) updates.notes = notes;

    const existing = firstOrNull(
      await db
        .select({ organizationId: organizationBilling.organizationId })
        .from(organizationBilling)
        .where(eq(organizationBilling.organizationId, orgId))
        .limit(1),
    );

    let row: typeof organizationBilling.$inferSelect;
    if (existing) {
      [row] = await db
        .update(organizationBilling)
        .set(updates)
        .where(eq(organizationBilling.organizationId, orgId))
        .returning();
    } else {
      // Create the satellite. status defaults to 'active' when not sent;
      // started_at defaults to now so the client's "entrada" is populated.
      [row] = await db
        .insert(organizationBilling)
        .values({
          organizationId: orgId,
          status: status ?? "active",
          startedAt: startedAt !== undefined ? startedAt : now,
          dueAt: dueAt ?? null,
          plan: plan ?? null,
          billingPhone: billingPhone ?? null,
          notes: notes ?? null,
        })
        .returning();
    }

    return NextResponse.json(row);
  } catch (err) {
    return toErrorResponse(err);
  }
}
