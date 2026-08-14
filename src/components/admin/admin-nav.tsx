"use client";

// Navegação do painel /admin — alterna entre Clientes e o setor Suporte.
// Client component só pra destacar a aba ativa (usePathname).

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Users, LifeBuoy } from "lucide-react";

import { cn } from "@/lib/utils";

const TABS = [
  { href: "/admin", label: "Clientes", icon: Users, exact: true },
  { href: "/admin/suporte", label: "Suporte", icon: LifeBuoy, exact: false },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1">
      {TABS.map((t) => {
        const active = t.exact
          ? pathname === t.href
          : pathname.startsWith(t.href);
        const Icon = t.icon;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors",
              active
                ? "bg-primary/10 font-medium text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
