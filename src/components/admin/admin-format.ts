// Small pt-BR formatting helpers shared across the /admin panel.

import type { ClientBillingStatus } from "./admin-types";

/** DD/MM/YYYY (pt-BR) for an ISO timestamp; em-dash when null/invalid. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

/** DD/MM HH:mm (pt-BR) for a reminder timestamp; em-dash when absent. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${min}`;
}

/** true when the due date is in the past AND the client isn't suspended. */
export function isOverdue(
  dueAt: string | null,
  status: ClientBillingStatus,
): boolean {
  if (!dueAt || status === "suspended") return false;
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < Date.now();
}

/** Convert an ISO timestamp → yyyy-mm-dd for <input type="date">. */
export function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

export const STATUS_LABEL: Record<ClientBillingStatus, string> = {
  active: "Ativo",
  suspended: "Suspenso",
  trial: "Trial",
};
