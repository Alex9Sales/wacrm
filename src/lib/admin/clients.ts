// ============================================================
// Super-admin client data helpers (Phase 8). Server-only.
//
// These read ACROSS all organizations (no tenant scoping) — they are
// the data layer for the /admin panel and MUST only ever be reached
// behind requirePlatformAdmin. They never take an accountId.
//
//   listClients()     — every org + billing + owner + member/channel counts.
//   getClientOverview() — status counters (total/active/suspended/trial/overdue).
// ============================================================

import { eq, sql, asc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  db,
  organization,
  organizationBilling,
  member,
  channels,
  user,
} from "@/db";

export type ClientBillingStatus =
  | "active"
  | "suspended"
  | "trial"
  | "canceled"
  | "deleted";

export interface ClientListRow {
  id: string;
  name: string;
  slug: string | null;
  createdAt: string;
  /** Status EFETIVO (satélite Phase 8 + ciclo de vida 0102): considera
   *  deleted_at e cancel_at já vencido. Default 'active' quando não há linha. */
  status: ClientBillingStatus;
  /** Cancelamento agendado (fim do período pago). Se no futuro, a conta ainda
   *  está ativa e o painel mostra "cancela em DD/MM". */
  cancelAt: string | null;
  /** Soft-delete — quando setado, a conta está excluída. */
  deletedAt: string | null;
  startedAt: string | null;
  dueAt: string | null;
  plan: string | null;
  billingPhone: string | null;
  notes: string | null;
  lastReminderAt: string | null;
  /** Owner member's user (first owner by membership order), if any. */
  owner: { email: string; name: string } | null;
  /** Platform admin (Alex/Rafael) responsible for this client, if assigned. */
  responsible: { id: string; email: string; name: string } | null;
  memberCount: number;
  channelCount: number;
}

/**
 * List every organization with its billing satellite, owner, and
 * member/channel counts. Ordered by due date (nulls last) so the UI
 * can surface the soonest-due / overdue clients first.
 */
export async function listClients(): Promise<ClientListRow[]> {
  const memberCount = sql<number>`(
    SELECT count(*)::int FROM ${member} m WHERE m.organization_id = ${organization.id}
  )`;
  const channelCount = sql<number>`(
    SELECT count(*)::int FROM ${channels} c WHERE c.account_id = ${organization.id}
  )`;
  // First owner member's user id (by membership creation order).
  const ownerUserId = sql<string | null>`(
    SELECT m.user_id FROM ${member} m
    WHERE m.organization_id = ${organization.id} AND m.role = 'owner'
    ORDER BY m.created_at ASC
    LIMIT 1
  )`;

  // Second `user` join for the responsible platform admin (distinct from the
  // client's owner join above).
  const respUser = alias(user, "resp_user");

  const rows = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      createdAt: organization.createdAt,
      // Status EFETIVO: excluída > cancelada (status ou cancel_at vencido) > o resto.
      status: sql<string>`CASE
        WHEN ${organizationBilling.deletedAt} IS NOT NULL THEN 'deleted'
        WHEN ${organizationBilling.status} = 'canceled'
          OR (${organizationBilling.cancelAt} IS NOT NULL AND ${organizationBilling.cancelAt} <= now())
          THEN 'canceled'
        ELSE COALESCE(${organizationBilling.status}, 'active')
      END`,
      cancelAt: organizationBilling.cancelAt,
      deletedAt: organizationBilling.deletedAt,
      startedAt: organizationBilling.startedAt,
      dueAt: organizationBilling.dueAt,
      plan: organizationBilling.plan,
      billingPhone: organizationBilling.billingPhone,
      notes: organizationBilling.notes,
      lastReminderAt: organizationBilling.lastReminderAt,
      ownerEmail: user.email,
      ownerName: user.name,
      responsibleId: respUser.id,
      responsibleEmail: respUser.email,
      responsibleName: respUser.name,
      memberCount,
      channelCount,
    })
    .from(organization)
    .leftJoin(
      organizationBilling,
      eq(organizationBilling.organizationId, organization.id),
    )
    .leftJoin(user, eq(user.id, ownerUserId))
    .leftJoin(respUser, eq(respUser.id, organizationBilling.responsibleAdminId))
    // Nulls (no due date) sort last so overdue / soon-due lead.
    .orderBy(sql`${organizationBilling.dueAt} ASC NULLS LAST`, asc(organization.createdAt));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    createdAt: r.createdAt,
    status: (r.status ?? "active") as ClientBillingStatus,
    cancelAt: r.cancelAt,
    deletedAt: r.deletedAt,
    startedAt: r.startedAt,
    dueAt: r.dueAt,
    plan: r.plan,
    billingPhone: r.billingPhone,
    notes: r.notes,
    lastReminderAt: r.lastReminderAt,
    owner: r.ownerEmail ? { email: r.ownerEmail, name: r.ownerName ?? "" } : null,
    responsible: r.responsibleId
      ? {
          id: r.responsibleId,
          email: r.responsibleEmail ?? "",
          name: r.responsibleName ?? "",
        }
      : null,
    memberCount: Number(r.memberCount ?? 0),
    channelCount: Number(r.channelCount ?? 0),
  }));
}

export interface ClientOverview {
  /** Base viva (não conta as excluídas). */
  total: number;
  active: number;
  suspended: number;
  trial: number;
  canceled: number;
  deleted: number;
  /** due_at in the past AND effectively active (not suspended/canceled/deleted). */
  overdue: number;
}

/**
 * Status counters across all organizations. `total` counts every org
 * (billing row or not); orgs without a billing row count as 'active'
 * (matching the suspension chokepoint's legacy default).
 */
export async function getClientOverview(): Promise<ClientOverview> {
  // Condições reaproveitadas (SQL). "vivo" = não excluído; "cancelado efetivo"
  // = status canceled OU cancel_at já vencido; "ativo efetivo" = sem bloqueio.
  const notDeleted = sql`${organizationBilling.deletedAt} IS NULL`;
  const effCanceled = sql`(${organizationBilling.status} = 'canceled' OR (${organizationBilling.cancelAt} IS NOT NULL AND ${organizationBilling.cancelAt} <= now()))`;
  const effActive = sql`(${organizationBilling.status} IS NULL OR ${organizationBilling.status} = 'active') AND (${organizationBilling.cancelAt} IS NULL OR ${organizationBilling.cancelAt} > now())`;

  const [row] = await db
    .select({
      // Base viva: não conta as excluídas.
      total: sql<number>`count(*) FILTER (WHERE ${notDeleted})::int`,
      active: sql<number>`count(*) FILTER (WHERE ${notDeleted} AND ${effActive})::int`,
      suspended: sql<number>`count(*) FILTER (WHERE ${notDeleted} AND ${organizationBilling.status} = 'suspended')::int`,
      trial: sql<number>`count(*) FILTER (WHERE ${notDeleted} AND ${organizationBilling.status} = 'trial')::int`,
      canceled: sql<number>`count(*) FILTER (WHERE ${notDeleted} AND ${effCanceled})::int`,
      deleted: sql<number>`count(*) FILTER (WHERE ${organizationBilling.deletedAt} IS NOT NULL)::int`,
      overdue: sql<number>`count(*) FILTER (WHERE ${notDeleted} AND ${organizationBilling.dueAt} < now() AND ${organizationBilling.status} IS DISTINCT FROM 'suspended' AND NOT ${effCanceled})::int`,
    })
    .from(organization)
    .leftJoin(
      organizationBilling,
      eq(organizationBilling.organizationId, organization.id),
    );

  return {
    total: Number(row?.total ?? 0),
    active: Number(row?.active ?? 0),
    suspended: Number(row?.suspended ?? 0),
    trial: Number(row?.trial ?? 0),
    canceled: Number(row?.canceled ?? 0),
    deleted: Number(row?.deleted ?? 0),
    overdue: Number(row?.overdue ?? 0),
  };
}
