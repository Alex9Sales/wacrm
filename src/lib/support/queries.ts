// ============================================================
// Suporte — leitura dos chamados. Server-only.
//
//   listOrgTickets(accountId) — chamados de UMA org (tela /suporte do cliente).
//   listAllTickets()          — TODOS os chamados + org + autor (setor /admin).
//   getSupportOverview()      — contadores por status (setor /admin).
//
// listAllTickets/getSupportOverview leem ACROSS orgs → só atrás de
// requirePlatformAdmin. listOrgTickets é account-scoped.
// ============================================================

import { desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db, supportTickets, organization, user } from "@/db";
import type {
  AdminSupportTicketDTO,
  SupportContext,
  SupportOverview,
  SupportTicketDTO,
  SupportTicketStatus,
  SupportTicketType,
} from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function serializeTicket(row: any): SupportTicketDTO {
  return {
    id: row.id as string,
    type: (row.type ?? "problem") as SupportTicketType,
    subject: row.subject as string,
    description: (row.description as string | null) ?? null,
    screenshotUrls: Array.isArray(row.screenshotUrls)
      ? (row.screenshotUrls as string[])
      : [],
    context: (row.context ?? {}) as SupportContext,
    status: (row.status ?? "open") as SupportTicketStatus,
    alertedAt: (row.alertedAt as string | null) ?? null,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Chamados de uma org, mais novos primeiro (tela do cliente). */
export async function listOrgTickets(
  accountId: string,
  limit = 30,
): Promise<SupportTicketDTO[]> {
  const rows = await db
    .select()
    .from(supportTickets)
    .where(eq(supportTickets.accountId, accountId))
    .orderBy(desc(supportTickets.createdAt))
    .limit(limit);
  return rows.map(serializeTicket);
}

/** Todos os chamados + org + autor (setor Suporte do /admin). */
export async function listAllTickets(
  limit = 200,
): Promise<AdminSupportTicketDTO[]> {
  const author = alias(user, "author");
  const rows = await db
    .select({
      id: supportTickets.id,
      type: supportTickets.type,
      subject: supportTickets.subject,
      description: supportTickets.description,
      screenshotUrls: supportTickets.screenshotUrls,
      context: supportTickets.context,
      status: supportTickets.status,
      alertedAt: supportTickets.alertedAt,
      createdAt: supportTickets.createdAt,
      updatedAt: supportTickets.updatedAt,
      orgId: organization.id,
      orgName: organization.name,
      authorName: author.name,
      authorEmail: author.email,
    })
    .from(supportTickets)
    .leftJoin(organization, eq(organization.id, supportTickets.accountId))
    .leftJoin(author, eq(author.id, supportTickets.createdBy))
    .orderBy(desc(supportTickets.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    ...serializeTicket(r),
    org: r.orgId ? { id: r.orgId, name: r.orgName ?? "" } : null,
    createdByUser: r.authorEmail
      ? { name: r.authorName ?? "", email: r.authorEmail }
      : null,
  }));
}

/** Contadores por status (todos os chamados). */
export async function getSupportOverview(): Promise<SupportOverview> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) FILTER (WHERE ${supportTickets.status} = 'open')::int`,
      inProgress: sql<number>`count(*) FILTER (WHERE ${supportTickets.status} = 'in_progress')::int`,
      resolved: sql<number>`count(*) FILTER (WHERE ${supportTickets.status} = 'resolved')::int`,
    })
    .from(supportTickets);

  return {
    total: Number(row?.total ?? 0),
    open: Number(row?.open ?? 0),
    inProgress: Number(row?.inProgress ?? 0),
    resolved: Number(row?.resolved ?? 0),
  };
}
