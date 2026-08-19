// ============================================================
// Server-side account context — for API routes and server
// components. Resolves the caller's user + active organization +
// role from Better Auth, then loads the organization row.
//
// Tenancy = Better Auth `organization`; membership + role live in
// `member`. There is no RLS — every downstream query MUST be scoped
// by `ctx.accountId` (= the active organization id).
//
// Calling convention
// ------------------
//   try {
//     const ctx = await requireRole("admin");
//     // ctx.userId / ctx.accountId / ctx.role / ctx.account
//   } catch (err) {
//     return toErrorResponse(err);
//   }
// ============================================================

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq, asc } from "drizzle-orm";

import { db, organization, member, organizationBilling } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { auth } from "@/lib/auth";
import { getSessionUserId } from "./session";
import { hasMinRole, isAccountRole, type AccountRole } from "./roles";

// ------------------------------------------------------------
// Errors
// ------------------------------------------------------------

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * The active organization's billing status is 'suspended' (Phase 8 —
 * super-admin suspension). Raised from `getCurrentAccount`, so it
 * short-circuits every org-scoped request. Platform admins operate via
 * /admin (requirePlatformAdmin), which never calls getCurrentAccount,
 * so they're unaffected.
 */
export class AccountSuspendedError extends Error {
  readonly status = 403 as const;
  constructor(message = "Conta suspensa. Fale com a Fluxia.") {
    super(message);
    this.name = "AccountSuspendedError";
  }
}

/**
 * The active organization is on a TRIAL whose end date (billing `dueAt`) has
 * passed. Like suspension, this short-circuits every org-scoped request from
 * `getCurrentAccount` so the dashboard can show a "teste acabou" screen and
 * (Fase 3) the checkout. Cleared when billing flips to 'active'.
 */
export class TrialExpiredError extends Error {
  readonly status = 402 as const;
  constructor(message = "Seu teste grátis terminou. Assine para continuar.") {
    super(message);
    this.name = "TrialExpiredError";
  }
}

/**
 * A assinatura da organização foi CANCELADA (status='canceled', ou o
 * cancelamento agendado `cancel_at` já passou). Bloqueia como a suspensão, mas
 * com a tela "assinatura cancelada". Limpa quando o billing volta a 'active'.
 */
export class AccountCanceledError extends Error {
  readonly status = 403 as const;
  constructor(message = "Sua assinatura foi cancelada. Assine novamente para voltar.") {
    super(message);
    this.name = "AccountCanceledError";
  }
}

/**
 * A conta foi EXCLUÍDA (soft-delete, `deleted_at` setado). Bloqueia todo acesso
 * org-scoped com a tela "conta encerrada". O registro é mantido pro histórico.
 */
export class AccountDeletedError extends Error {
  readonly status = 403 as const;
  constructor(message = "Esta conta foi encerrada. Fale com a Fluxia.") {
    super(message);
    this.name = "AccountDeletedError";
  }
}

/**
 * Convert one of the typed errors above (or anything else) into a
 * `NextResponse`. Unknown errors collapse to 500 with the generic
 * message — we never leak `err.message` for non-classified errors.
 */
export function toErrorResponse(err: unknown): NextResponse {
  if (
    err instanceof UnauthorizedError ||
    err instanceof ForbiddenError ||
    err instanceof AccountSuspendedError ||
    err instanceof TrialExpiredError ||
    err instanceof AccountCanceledError ||
    err instanceof AccountDeletedError
  ) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[toErrorResponse] uncategorized error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

// ------------------------------------------------------------
// Account context
// ------------------------------------------------------------

export interface AccountContext {
  /** The calling user's id. Always defined when this resolves. */
  userId: string;
  /** Active organization id — the tenant scope for every query. */
  accountId: string;
  /** Caller's role within the active organization. */
  role: AccountRole;
  /** Lightweight account meta — id + name. */
  account: { id: string; name: string };
  /** Active organization's default deal currency (ISO-4217). */
  defaultCurrency?: string;
}

/**
 * Resolve the caller's active-organization id + role.
 *
 * Primary path: the Better Auth session (activeOrganizationId) +
 * `getActiveMember` for the role. Fallback path (dev): when there's
 * no real session but `getSessionUserId` yields the seed user, we
 * resolve the org + role directly from that user's first membership.
 */
async function resolveActiveOrg(
  userId: string,
): Promise<{ organizationId: string; role: string } | null> {
  // Primary: read the Better Auth session's active org + active member.
  try {
    const reqHeaders = await headers();
    const session = await auth.api.getSession({ headers: reqHeaders });
    const activeOrgId = session?.session?.activeOrganizationId ?? null;
    if (session?.user?.id === userId && activeOrgId) {
      const activeMember = await auth.api.getActiveMember({
        headers: reqHeaders,
      });
      if (activeMember?.role) {
        return { organizationId: activeOrgId, role: activeMember.role };
      }
    }
  } catch (err) {
    console.error("[resolveActiveOrg] session lookup failed:", err);
  }

  // Fallback (dev seed / no active session): first membership row.
  const membership = firstOrNull(
    await db
      .select({ organizationId: member.organizationId, role: member.role })
      .from(member)
      .where(eq(member.userId, userId))
      .orderBy(asc(member.createdAt))
      .limit(1),
  );
  if (membership) {
    return { organizationId: membership.organizationId, role: membership.role };
  }
  return null;
}

/**
 * Resolve the caller's user + account + role.
 *
 * Throws `UnauthorizedError` if there's no session.
 * Throws `ForbiddenError` if the user has no active organization /
 * membership, or the organization row is missing.
 *
 * Use `requireRole(min)` instead when the route also needs a
 * minimum-role check — it's a thin wrapper over this.
 */
export async function getCurrentAccount(): Promise<AccountContext> {
  return loadAccountContext(true);
}

/**
 * Como `getCurrentAccount`, mas SEM o gate de billing (suspenso / trial vencido).
 * Existe só pro fluxo de assinatura/checkout — que precisa rodar JUSTAMENTE
 * quando o trial venceu (senão o próprio checkout cairia no 402). NÃO use em
 * rotas normais: elas devem passar pelo gate via `getCurrentAccount`.
 */
export async function getBillingContext(): Promise<AccountContext> {
  return loadAccountContext(false);
}

async function loadAccountContext(
  enforceBilling: boolean,
): Promise<AccountContext> {
  const userId = await getSessionUserId();
  if (!userId) {
    throw new UnauthorizedError();
  }

  const active = await resolveActiveOrg(userId);
  if (!active) {
    // Authenticated but no organization membership — the app has no
    // way to scope their queries.
    throw new ForbiddenError("User is not a member of any organization");
  }

  if (!isAccountRole(active.role)) {
    // member.role is free-text; guard against a value TS doesn't know.
    throw new ForbiddenError(`Unknown account role: ${active.role}`);
  }

  const account = firstOrNull(
    await db
      .select({
        id: organization.id,
        name: organization.name,
        defaultCurrency: organization.default_currency,
      })
      .from(organization)
      .where(eq(organization.id, active.organizationId))
      .limit(1),
  );

  if (!account) {
    // active org points at no organization row — orphaned session.
    throw new ForbiddenError("Active organization not found");
  }

  // Phase 8 suspension enforcement: if the org's billing row is
  // 'suspended', block every org-scoped request here (the chokepoint).
  // No billing row → treat as active (legacy orgs predate the satellite).
  // O checkout usa getBillingContext (enforceBilling=false) pra pular isto.
  if (enforceBilling) {
    const billing = firstOrNull(
      await db
        .select({
          status: organizationBilling.status,
          dueAt: organizationBilling.dueAt,
          cancelAt: organizationBilling.cancelAt,
          deletedAt: organizationBilling.deletedAt,
        })
        .from(organizationBilling)
        .where(eq(organizationBilling.organizationId, account.id))
        .limit(1),
    );
    // Conta excluída (soft-delete) — bloqueia tudo. Vem antes dos demais.
    if (billing?.deletedAt) {
      throw new AccountDeletedError();
    }
    if (billing?.status === "suspended") {
      throw new AccountSuspendedError();
    }
    // Cancelada: status já 'canceled', OU o cancelamento agendado (cancel_at =
    // fim do período pago) já passou. Antes de cancel_at o acesso continua.
    if (
      billing?.status === "canceled" ||
      (billing?.cancelAt && new Date(billing.cancelAt).getTime() < Date.now())
    ) {
      throw new AccountCanceledError();
    }
    // Fase 2: trial cujo fim (dueAt) já passou → bloqueia como suspensão, mas
    // com a tela "teste acabou" + checkout. Sem billing / active → não afeta.
    if (
      billing?.status === "trial" &&
      billing.dueAt &&
      new Date(billing.dueAt).getTime() < Date.now()
    ) {
      throw new TrialExpiredError();
    }
  }

  return {
    userId,
    accountId: account.id,
    role: active.role,
    account: { id: account.id, name: account.name },
    defaultCurrency: account.defaultCurrency,
  };
}

/**
 * Resolve the caller's account context and enforce a minimum role.
 *
 * Throws `UnauthorizedError` / `ForbiddenError` as documented on
 * `getCurrentAccount`, plus `ForbiddenError` when the caller is
 * below `min`.
 */
export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      `This action requires the '${min}' role or higher`,
    );
  }
  return ctx;
}
