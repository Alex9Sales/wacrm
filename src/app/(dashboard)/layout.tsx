import type { Metadata } from "next";
import { DashboardShell } from "./dashboard-shell";
import { UpdateBanner } from "@/components/layout/update-banner";
import { getBuildId } from "@/lib/version";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/auth/session";

// Server layout whose only job is to declare "do not index" metadata
// for the authed app. robots.ts already disallows these paths at the
// crawler-level and middleware redirects unauthenticated visitors, so
// this is belt-and-suspenders — but SEO-critical if a URL ever leaks
// via a link shared externally.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 02/09: o middleware só consegue checar PRESENÇA do cookie. Cookie inválido
  // (sessão apagada/expirada) chegava aqui e recebia a casca do app com 401 em
  // tudo. Uma consulta de sessão por navegação e o usuário vai pro login.
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  return (
    <>
      <UpdateBanner initialBuildId={getBuildId()} />
      <DashboardShell>{children}</DashboardShell>
    </>
  );
}
