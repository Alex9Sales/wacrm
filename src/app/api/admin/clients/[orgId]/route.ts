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
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";

import { db, organization, organizationBilling } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin, listPlatformAdmins } from "@/lib/auth/platform";
import { phonesMatch } from "@/lib/whatsapp/phone-utils";

const VALID_STATUS = new Set(["active", "suspended", "trial"]);

interface PatchBody {
  status?: unknown;
  started_at?: unknown;
  due_at?: unknown;
  plan?: unknown;
  billing_phone?: unknown;
  notes?: unknown;
  responsible_admin_id?: unknown;
  // Vínculo com o Asaas (24/09): documento do cliente, valor realmente
  // contratado e os ids de lá. Ver drizzle/0191.
  cpf_cnpj?: unknown;
  monthly_value?: unknown;
  asaas_customer_id?: unknown;
  asaas_subscription_id?: unknown;
}

/**
 * Valor em reais. undefined = não mexe, null = limpa, número > 0 = grava.
 * Aceita "1.298,50" e "1298.50" — o admin digita como está no Asaas.
 */
function optionalMoney(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const raw = typeof v === "number" ? String(v) : typeof v === "string" ? v : null;
  if (raw === null) return undefined;
  const norm = raw.trim().replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(norm);
  if (!Number.isFinite(n) || n < 0) throw new Error("invalid-money");
  return n > 0 ? n.toFixed(2) : null;
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
    // Documento sempre em dígitos: é assim que o Asaas procura.
    const cpfCnpjRaw = optionalText(body.cpf_cnpj);
    const cpfCnpj =
      cpfCnpjRaw === undefined || cpfCnpjRaw === null
        ? cpfCnpjRaw
        : cpfCnpjRaw.replace(/\D/g, "") || null;
    const asaasCustomerId = optionalText(body.asaas_customer_id);
    const asaasSubscriptionId = optionalText(body.asaas_subscription_id);
    let monthlyValue: string | null | undefined;
    try {
      monthlyValue = optionalMoney(body.monthly_value);
    } catch {
      return NextResponse.json(
        { error: "monthly_value inválido (use um número, ex.: 1298,50)." },
        { status: 400 },
      );
    }

    // Responsible admin (tri-state): undefined = untouched, null = clear,
    // string = must be a real platform admin's user id (else 400).
    let responsibleAdminId: string | null | undefined;
    if (body.responsible_admin_id !== undefined) {
      if (body.responsible_admin_id === null || body.responsible_admin_id === "") {
        responsibleAdminId = null;
      } else if (typeof body.responsible_admin_id === "string") {
        const admins = await listPlatformAdmins();
        if (!admins.some((a) => a.id === body.responsible_admin_id)) {
          return NextResponse.json(
            { error: "Responsável inválido (precisa ser um admin da plataforma)." },
            { status: 400 },
          );
        }
        responsibleAdminId = body.responsible_admin_id;
      } else {
        return NextResponse.json(
          { error: "responsible_admin_id inválido." },
          { status: 400 },
        );
      }
    }

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
    if (responsibleAdminId !== undefined)
      updates.responsibleAdminId = responsibleAdminId;
    if (cpfCnpj !== undefined) updates.cpfCnpj = cpfCnpj;
    if (monthlyValue !== undefined) updates.monthlyValue = monthlyValue;
    if (asaasCustomerId !== undefined) updates.asaasCustomerId = asaasCustomerId;
    if (asaasSubscriptionId !== undefined)
      updates.asaasSubscriptionId = asaasSubscriptionId;

    // ⚠️ 25/09: 5 clientes tinham o telefone do RESPONSÁVEL (Rafael) no lugar
    // do telefone do cliente — ou seja, o lembrete da mensalidade de 3
    // clientes ATIVOS ia para o WhatsApp dele e o cliente nunca recebia.
    // Ninguém viu porque salvar o mesmo número em vários clientes não dizia
    // nada. Agora a resposta traz o aviso (não bloqueia: dois CNPJs do mesmo
    // dono são caso legítimo) e a tela mostra de quem é o número.
    let phoneWarning: string | null = null;
    if (billingPhone) {
      const outros = await db
        .select({
          name: organization.name,
          phone: organizationBilling.billingPhone,
        })
        .from(organizationBilling)
        .innerJoin(
          organization,
          eq(organization.id, organizationBilling.organizationId),
        )
        .where(
          and(
            ne(organizationBilling.organizationId, orgId),
            isNull(organizationBilling.deletedAt),
            isNotNull(organizationBilling.billingPhone),
          ),
        );
      const donos = outros
        .filter((o) => o.phone && phonesMatch(o.phone, billingPhone))
        .map((o) => o.name);
      if (donos.length > 0) {
        phoneWarning = `Este telefone já é o de cobrança de ${donos.join(', ')}. Confirme que é o número de quem paga ESTE cliente, e não o de quem cuida da conta.`;
      }
    }

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
          responsibleAdminId: responsibleAdminId ?? null,
          cpfCnpj: cpfCnpj ?? null,
          monthlyValue: monthlyValue ?? null,
          asaasCustomerId: asaasCustomerId ?? null,
          asaasSubscriptionId: asaasSubscriptionId ?? null,
        })
        .returning();
    }

    return NextResponse.json({ ...row, phoneWarning });
  } catch (err) {
    return toErrorResponse(err);
  }
}
