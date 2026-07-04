// ============================================================
// /admin — the client management dashboard (Phase 8).
//
// Server component: re-asserts requirePlatformAdmin (belt-and-suspenders
// alongside the layout gate — every /admin page MUST gate server-side),
// then hands off to the client component which fetches the GET APIs and
// drives the mutations.
// ============================================================

import { redirect } from "next/navigation";

import { requirePlatformAdmin } from "@/lib/auth/platform";
import { UnauthorizedError, ForbiddenError } from "@/lib/auth/account";
import { AdminClients } from "@/components/admin/admin-clients";

export default async function AdminPage() {
  try {
    await requirePlatformAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/login");
    // ForbiddenError is already handled by the layout's AccessDenied
    // screen, but guard here too so a direct render can't leak the panel.
    if (err instanceof ForbiddenError) redirect("/dashboard");
    throw err;
  }

  return <AdminClients />;
}
