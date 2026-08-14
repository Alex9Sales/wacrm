// ============================================================
// /admin/suporte — o setor Suporte do painel (Fase Suporte).
//
// Server component: re-asserta requirePlatformAdmin (o layout também gate),
// depois entrega ao client component que busca /api/admin/support e dirige
// as mutações de status.
// ============================================================

import { redirect } from "next/navigation";

import { requirePlatformAdmin } from "@/lib/auth/platform";
import { UnauthorizedError, ForbiddenError } from "@/lib/auth/account";
import { AdminSupport } from "@/components/admin/admin-support";

export default async function AdminSupportPage() {
  try {
    await requirePlatformAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/login");
    if (err instanceof ForbiddenError) redirect("/dashboard");
    throw err;
  }

  return <AdminSupport />;
}
