// ============================================================
// Histórico de billing (billing_events) — server-only, /admin.
// Trilha de auditoria do ciclo de vida da conta: quem fez, quando, por quê.
// Gravar em TODA ação de billing; ler pro modal de histórico do cliente.
// ============================================================

import { desc, eq } from "drizzle-orm";

import { db, billingEvents } from "@/db";

export type BillingActorType = "admin" | "client" | "system";

export interface LogBillingEventInput {
  organizationId: string;
  /** provisioned | activated | suspended | reactivated | canceled | deleted |
   *  plan_changed | reminder_sent | payment_received | … */
  event: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  actorType?: BillingActorType;
  /** id do admin da plataforma (quando actorType='admin'). */
  actorId?: string | null;
  /** snapshot legível de quem agiu (nome/e-mail). */
  actorLabel?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

/** Grava um evento no histórico. Best-effort: nunca derruba a ação principal. */
export async function logBillingEvent(input: LogBillingEventInput): Promise<void> {
  try {
    await db.insert(billingEvents).values({
      organizationId: input.organizationId,
      event: input.event,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      actorType: input.actorType ?? "admin",
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel ?? null,
      reason: input.reason ?? null,
      metadata: input.metadata ?? {},
    });
  } catch (err) {
    console.error("[billing-events] falha ao gravar evento", input.event, err);
  }
}

export interface BillingEventRow {
  id: string;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorType: string;
  actorLabel: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Histórico de um cliente, mais novo primeiro. */
export async function listBillingEvents(
  organizationId: string,
): Promise<BillingEventRow[]> {
  const rows = await db
    .select({
      id: billingEvents.id,
      event: billingEvents.event,
      fromStatus: billingEvents.fromStatus,
      toStatus: billingEvents.toStatus,
      actorType: billingEvents.actorType,
      actorLabel: billingEvents.actorLabel,
      reason: billingEvents.reason,
      metadata: billingEvents.metadata,
      createdAt: billingEvents.createdAt,
    })
    .from(billingEvents)
    .where(eq(billingEvents.organizationId, organizationId))
    .orderBy(desc(billingEvents.createdAt))
    .limit(200);

  return rows.map((r) => ({
    id: r.id,
    event: r.event,
    fromStatus: r.fromStatus,
    toStatus: r.toStatus,
    actorType: r.actorType,
    actorLabel: r.actorLabel,
    reason: r.reason,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    createdAt: r.createdAt as string,
  }));
}
