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

export type ClientBillingStatus = "active" | "suspended" | "trial";

export interface ClientListRow {
  id: string;
  name: string;
  slug: string | null;
  createdAt: string;
  /** Billing satellite (Phase 8). status defaults to 'active' when no row. */
  status: ClientBillingStatus;
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
      status: organizationBilling.status,
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
  total: number;
  active: number;
  suspended: number;
  trial: number;
  /** due_at in the past AND not suspended. */
  overdue: number;
}

/**
 * Status counters across all organizations. `total` counts every org
 * (billing row or not); orgs without a billing row count as 'active'
 * (matching the suspension chokepoint's legacy default).
 */
export async function getClientOverview(): Promise<ClientOverview> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      // No billing row → active (legacy default).
      active: sql<number>`count(*) FILTER (WHERE ${organizationBilling.status} IS NULL OR ${organizationBilling.status} = 'active')::int`,
      suspended: sql<number>`count(*) FILTER (WHERE ${organizationBilling.status} = 'suspended')::int`,
      trial: sql<number>`count(*) FILTER (WHERE ${organizationBilling.status} = 'trial')::int`,
      overdue: sql<number>`count(*) FILTER (WHERE ${organizationBilling.dueAt} < now() AND ${organizationBilling.status} IS DISTINCT FROM 'suspended')::int`,
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
    overdue: Number(row?.overdue ?? 0),
  };
}
