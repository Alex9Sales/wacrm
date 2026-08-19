// Shared client-side types for the /admin panel (Phase 8). These mirror
// the server shapes in src/lib/admin/clients.ts (ClientListRow /
// ClientOverview) so the client components don't import server-only code.

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
  status: ClientBillingStatus;
  cancelAt: string | null;
  deletedAt: string | null;
  startedAt: string | null;
  dueAt: string | null;
  plan: string | null;
  billingPhone: string | null;
  notes: string | null;
  lastReminderAt: string | null;
  owner: { email: string; name: string } | null;
  responsible: { id: string; email: string; name: string } | null;
  memberCount: number;
  channelCount: number;
}

/** A platform admin (Alex/Rafael) that can own clients — for the picker. */
export interface PlatformAdminUser {
  id: string;
  name: string;
  email: string;
}

export interface ClientOverview {
  total: number;
  active: number;
  suspended: number;
  trial: number;
  canceled: number;
  deleted: number;
  overdue: number;
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

export interface AdminClientsResponse {
  clients: ClientListRow[];
  overview: ClientOverview;
  admins: PlatformAdminUser[];
  /** The requesting admin's own user id — drives the "Meus" filter (the /admin
   *  route has no AuthProvider, so the client can't read it from useAuth). */
  currentAdminId: string;
}
