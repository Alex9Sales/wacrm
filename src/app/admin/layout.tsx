// ============================================================
// /admin layout — the super-admin (SaaS operator) panel (Phase 8).
//
// Its own section, ABOVE org tenancy — NOT nested in the client
// dashboard. Every /admin page is gated here server-side via
// requirePlatformAdmin(): on ForbiddenError we render a friendly
// "Acesso restrito" screen; UnauthorizedError bounces to /login.
// Middleware only checks the session cookie, so this DB-backed
// allowlist check is the real gate.
// ============================================================

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Shield } from "lucide-react";

import {
  requirePlatformAdmin,
  type PlatformAdminContext,
} from "@/lib/auth/platform";
import { AdminNav } from "@/components/admin/admin-nav";
import {
  UnauthorizedError,
  ForbiddenError,
} from "@/lib/auth/account";

export const metadata: Metadata = {
  title: "Admin · Fluxia",
  robots: { index: false, follow: false, nocache: true },
};

function AccessDenied() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <Shield className="size-7" />
      </div>
      <div className="max-w-md space-y-2">
        <h1 className="font-heading text-xl font-semibold text-foreground">
          Acesso restrito
        </h1>
        <p className="text-sm text-muted-foreground">
          Esta área é exclusiva dos operadores da Fluxia. Sua conta não
          tem permissão de plataforma.
        </p>
      </div>
      <Link
        href="/dashboard"
        className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        Voltar ao dashboard
      </Link>
    </div>
  );
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let ctx: PlatformAdminContext;
  try {
    ctx = await requirePlatformAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      redirect("/login");
    }
    if (err instanceof ForbiddenError) {
      return <AccessDenied />;
    }
    throw err;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 flex h-12 items-center justify-between border-b border-border bg-background px-4 lg:px-6">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Shield className="size-5 text-primary" />
            <span className="font-heading text-base font-semibold">
              Fluxia · Admin
            </span>
          </div>
          <AdminNav />
        </div>
        <div className="flex items-center gap-4">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {ctx.email}
          </span>
          <Link
            href="/dashboard"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Sair do admin
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl p-4 sm:p-6">{children}</main>
    </div>
  );
}
