// ============================================================
// Ciclo de vida da conta (server-only, /admin). Cancelar / excluir (soft) /
// reativar — sempre cancelando a assinatura no Asaas (best-effort) e gravando
// no histórico (billing_events). Só alcançável atrás de requirePlatformAdmin.
//
// Cancelar = "vale até o vencimento pago": cancel_at = due_at (o acesso segue
// até lá; depois o gate bloqueia). Com `immediate` ou sem due válido → agora.
// Excluir = soft-delete (deleted_at); mantém o registro + histórico.
// ============================================================

import { eq } from "drizzle-orm";

import { db, organizationBilling } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { cancelSubscription } from "@/lib/billing/asaas";
import { logBillingEvent } from "@/lib/admin/billing-events";

export interface AdminActor {
  userId: string;
  email: string;
}

/** Erro de regra do ciclo de vida → o route devolve 400 com a mensagem. */
export class LifecycleError extends Error {
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = "LifecycleError";
  }
}

export interface LifecycleResult {
  ok: true;
  /** Aviso quando o cancelamento no Asaas falhou (o acesso já foi tratado). */
  asaasWarning?: string;
  /** Data em que o cancelamento passa a valer (ISO). */
  effectiveAt?: string;
}

interface BillingSnap {
  status: string | null;
  dueAt: string | null;
  cancelAt: string | null;
  deletedAt: string | null;
  asaasSubscriptionId: string | null;
}

async function loadBilling(orgId: string): Promise<BillingSnap | null> {
  return firstOrNull(
    await db
      .select({
        status: organizationBilling.status,
        dueAt: organizationBilling.dueAt,
        cancelAt: organizationBilling.cancelAt,
        deletedAt: organizationBilling.deletedAt,
        asaasSubscriptionId: organizationBilling.asaasSubscriptionId,
      })
      .from(organizationBilling)
      .where(eq(organizationBilling.organizationId, orgId))
      .limit(1),
  );
}

/** Upsert do billing (cria a linha p/ orgs legadas sem satélite). */
async function applyBilling(
  orgId: string,
  patch: Partial<typeof organizationBilling.$inferInsert>,
): Promise<void> {
  const existing = firstOrNull(
    await db
      .select({ id: organizationBilling.organizationId })
      .from(organizationBilling)
      .where(eq(organizationBilling.organizationId, orgId))
      .limit(1),
  );
  if (existing) {
    await db
      .update(organizationBilling)
      .set(patch)
      .where(eq(organizationBilling.organizationId, orgId));
  } else {
    await db.insert(organizationBilling).values({
      organizationId: orgId,
      status: "active",
      startedAt: new Date().toISOString(),
      ...patch,
    });
  }
}

/** Cancela no Asaas (best-effort). Retorna uma msg de aviso ou null (ok). */
async function tryCancelAsaas(subId: string | null): Promise<string | null> {
  if (!subId) return null;
  try {
    await cancelSubscription(subId);
    return null;
  } catch (err) {
    console.error("[lifecycle] falha ao cancelar assinatura no Asaas", err);
    return "Acesso tratado, mas não consegui cancelar a assinatura no Asaas — confira no painel do Asaas.";
  }
}

/**
 * Cancela a assinatura. Padrão: vale até o vencimento pago (cancel_at=due_at);
 * `immediate` corta o acesso agora. Sempre cancela a cobrança no Asaas.
 */
export async function cancelClient(
  orgId: string,
  actor: AdminActor,
  opts: { reason?: string | null; immediate?: boolean } = {},
): Promise<LifecycleResult> {
  const b = await loadBilling(orgId);
  if (b?.deletedAt) throw new LifecycleError("Esta conta já foi excluída.");
  if (b?.status === "canceled")
    throw new LifecycleError("Esta assinatura já está cancelada.");

  const now = Date.now();
  const asaasWarning = await tryCancelAsaas(b?.asaasSubscriptionId ?? null);

  const dueMs = b?.dueAt ? new Date(b.dueAt).getTime() : null;
  // fim do período pago; sem due válido no futuro (ou immediate) → agora.
  const periodEndMs = !opts.immediate && dueMs && dueMs > now ? dueMs : now;
  const takesEffectNow = periodEndMs <= now;
  const cancelAtIso = new Date(periodEndMs).toISOString();

  const patch: Partial<typeof organizationBilling.$inferInsert> = {
    cancelAt: cancelAtIso,
    updatedAt: new Date(now).toISOString(),
  };
  if (takesEffectNow) patch.status = "canceled";
  await applyBilling(orgId, patch);

  await logBillingEvent({
    organizationId: orgId,
    event: "canceled",
    fromStatus: b?.status ?? "active",
    toStatus: takesEffectNow ? "canceled" : (b?.status ?? "active"),
    actorType: "admin",
    actorId: actor.userId,
    actorLabel: actor.email,
    reason: opts.reason ?? null,
    metadata: {
      immediate: !!opts.immediate,
      effective_at: cancelAtIso,
      asaas_canceled: !asaasWarning && !!b?.asaasSubscriptionId,
    },
  });

  return {
    ok: true,
    asaasWarning: asaasWarning ?? undefined,
    effectiveAt: cancelAtIso,
  };
}

/** Exclui a conta (soft-delete). Cancela a assinatura no Asaas. Mantém o registro. */
export async function deleteClient(
  orgId: string,
  actor: AdminActor,
  opts: { reason?: string | null } = {},
): Promise<LifecycleResult> {
  const b = await loadBilling(orgId);
  if (b?.deletedAt) throw new LifecycleError("Esta conta já foi excluída.");

  const asaasWarning = await tryCancelAsaas(b?.asaasSubscriptionId ?? null);
  const nowIso = new Date().toISOString();

  await applyBilling(orgId, {
    deletedAt: nowIso,
    cancelAt: b?.cancelAt ?? nowIso,
    updatedAt: nowIso,
  });

  await logBillingEvent({
    organizationId: orgId,
    event: "deleted",
    fromStatus: b?.status ?? "active",
    toStatus: "deleted",
    actorType: "admin",
    actorId: actor.userId,
    actorLabel: actor.email,
    reason: opts.reason ?? null,
    metadata: { asaas_canceled: !asaasWarning && !!b?.asaasSubscriptionId },
  });

  return { ok: true, asaasWarning: asaasWarning ?? undefined };
}

/** Reativa: restaura o acesso (status='active', limpa cancel_at e deleted_at).
 *  NÃO recria a assinatura no Asaas — se precisar cobrar, o cliente reassina. */
export async function reactivateClient(
  orgId: string,
  actor: AdminActor,
): Promise<LifecycleResult> {
  const b = await loadBilling(orgId);
  const nowIso = new Date().toISOString();

  await applyBilling(orgId, {
    status: "active",
    cancelAt: null,
    deletedAt: null,
    updatedAt: nowIso,
  });

  await logBillingEvent({
    organizationId: orgId,
    event: "reactivated",
    fromStatus: b?.status ?? null,
    toStatus: "active",
    actorType: "admin",
    actorId: actor.userId,
    actorLabel: actor.email,
    metadata: { was_deleted: !!b?.deletedAt },
  });

  return { ok: true };
}
