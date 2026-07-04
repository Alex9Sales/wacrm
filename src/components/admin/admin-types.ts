// Shared client-side types for the /admin panel (Phase 8). These mirror
// the server shapes in src/lib/admin/clients.ts (ClientListRow /
// ClientOverview) so the client components don't import server-only code.

export type ClientBillingStatus = "active" | "suspended" | "trial";

export interface ClientListRow {
  id: string;
  name: string;
  slug: string | null;
  createdAt: string;
  status: ClientBillingStatus;
  startedAt: string | null;
  dueAt: string | null;
  plan: string | null;
  billingPhone: string | null;
  notes: string | null;
  lastReminderAt: string | null;
  owner: { email: string; name: string } | null;
  memberCount: number;
  channelCount: number;
}

export interface ClientOverview {
  total: number;
  active: number;
  suspended: number;
  trial: number;
  overdue: number;
}

export interface AdminClientsResponse {
  clients: ClientListRow[];
  overview: ClientOverview;
}
