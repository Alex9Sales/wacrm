"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";
import { useTasksDueAlert } from "@/hooks/use-tasks-due-alert";
import { useInternalUnread } from "@/hooks/use-internal-unread";
import {
  BarChart3,
  Bell,
  Bot,
  Building2,
  CalendarClock,
  CalendarDays,
  Crown,
  ShieldCheck,
  GitBranch,
  ClipboardList,
  FileText,
  Gauge,
  LayoutDashboard,
  ListTodo,
  LogOut,
  MessageSquare,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  LifeBuoy,
  Phone,
  Radio,
  Settings,
  Shield,
  User,
  UserCog,
  Users,
  UsersRound,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import type { AccountRole } from "@/lib/auth/roles";

// Per-role chip metadata used in the sidebar's account strip + the
// Members tab roster. Keeping this near both consumers in a single
// place avoids drift between the two surfaces — when a designer
// wants to recolour "agent" rows, this is the one diff.
const ROLE_CHIP: Record<
  AccountRole,
  { icon: typeof Crown; label: string; className: string }
> = {
  owner: {
    icon: Crown,
    label: "Proprietário",
    // Amber: scarce, immutable, "the boss" — gets visual emphasis.
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-300",
  },
  admin: {
    icon: Shield,
    label: "Admin",
    // Primary-tinted: significant but not as scarce as owner.
    className:
      "border-primary/40 bg-primary/10 text-primary",
  },
  supervisor: {
    icon: ShieldCheck,
    label: "Supervisor",
    // Sky-tinted: management role just under admin.
    className:
      "border-sky-500/40 bg-sky-500/10 text-sky-300",
  },
  agent: {
    icon: UserCog,
    label: "Atendente",
    // Neutral slate: the operational default.
    className:
      "border-border bg-muted text-foreground",
  },
  viewer: {
    icon: User,
    label: "Visualizador",
    // Muted slate: read-only role; visually quieter than agent.
    className:
      "border-border bg-card text-muted-foreground",
  },
};
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FluxiaMark } from "@/components/brand/fluxia-logo";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /**
   * When true, the nav row renders a small "Beta" chip after the label.
   * Purely informational — doesn't affect routing or access.
   */
  beta?: boolean;
  /** Only shown to admins/owner (the page itself also enforces this). */
  adminOnly?: boolean;
  /** Only shown to supervisor+ (Painel/dashboard — the page also enforces it). */
  supervisorOnly?: boolean;
}

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Painel", icon: LayoutDashboard, supervisorOnly: true },
  { href: "/inbox", label: "Conversas", icon: MessageSquare },
  { href: "/calls", label: "Ligações", icon: Phone },
  { href: "/internal-chat", label: "Chat Interno", icon: MessagesSquare },
  { href: "/notifications", label: "Notificações", icon: Bell },
  { href: "/contacts", label: "Contatos", icon: Users },
  { href: "/empresas", label: "Empresas", icon: Building2 },
  { href: "/tarefas", label: "Tarefas", icon: ListTodo },
  { href: "/agenda", label: "Agenda", icon: CalendarDays },
  { href: "/pipelines", label: "Funis", icon: GitBranch },
  { href: "/propostas", label: "Propostas", icon: FileText },
  { href: "/captacao", label: "Captação", icon: ClipboardList },
  { href: "/relatorios", label: "Relatórios", icon: BarChart3 },
  { href: "/broadcasts", label: "Disparos", icon: Radio },
  { href: "/agendamentos", label: "Agendamentos", icon: CalendarClock },
  { href: "/automations", label: "Automações", icon: Zap },
  { href: "/flows", label: "Fluxos", icon: Workflow },
  { href: "/agents", label: "Agentes IA", icon: Bot },
  { href: "/supervisao", label: "Supervisão", icon: Gauge, adminOnly: true },
];

const bottomNavItems = [
  { href: "/suporte", label: "Suporte", icon: LifeBuoy },
  { href: "/settings", label: "Configurações", icon: Settings },
];

interface SidebarProps {
  /** Controlled on mobile by the Header's hamburger button. Ignored on lg+. */
  open?: boolean;
  onClose?: () => void;
}

const COLLAPSE_KEY = "fluxia-sidebar-collapsed";

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const pathname = usePathname();
  const { profile, profileLoading, account, accountRole, canEditSettings, canViewDashboard, signOut } =
    useAuth();

  // Desktop-only collapse (icon rail) — gives the chat more room. Persisted
  // across sessions. Starts expanded on the server, then syncs from storage
  // on mount to avoid a hydration mismatch (a brief flash if collapsed).
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* storage disabled — keep the in-memory state */
      }
      return next;
    });
  const totalUnread = useTotalUnread();
  const unreadNotifications = useUnreadNotifications();
  // Count of open tasks that are overdue or due today — drives the red
  // due-alert badge on the "Tarefas" entry.
  const tasksDueAlert = useTasksDueAlert();
  const internalUnread = useInternalUnread();
  // Only surface the account-name strip when it actually carries
  // information. A solo user's personal account is named after them
  // (the 017 signup trigger seeds it from `full_name`), so showing it
  // here would just duplicate the user name in the footer below. Once
  // the account is renamed or the user joins a shared account, the
  // name diverges and the strip becomes meaningful — that's the signal
  // we gate on. Wait for the profile fetch to settle first, otherwise
  // the strip flashes in once the row resolves (a layout jump).
  const showAccountStrip =
    !profileLoading &&
    !!account?.name &&
    account.name !== profile?.full_name;

  // Close the drawer when route changes — users opened it to navigate,
  // so once they pick a destination the drawer should get out of the way.
  useEffect(() => {
    onClose?.();
    // Only pathname drives this — onClose identity doesn't need to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Lock body scroll and allow Escape to close while the drawer is open on
  // mobile. No-ops on desktop because the sidebar isn't positioned there.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop — only exists on mobile and only when open. Clicking
          it closes the drawer. Hidden from lg+ since the sidebar is
          part of the main flex row there. */}
      <button
        type="button"
        aria-label="Fechar menu"
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-background/70 backdrop-blur-sm transition-opacity lg:hidden",
          open
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
      />

      <aside
        className={cn(
          // Mobile: fixed drawer that slides in from the left.
          "fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col border-r border-border bg-card",
          "transition-transform duration-200 ease-out will-change-transform",
          open ? "translate-x-0" : "-translate-x-full",
          // Desktop: static, always visible — reset all the mobile framing.
          "lg:static lg:z-0 lg:translate-x-0 lg:transition-none",
          // Desktop width: full when expanded, icon-rail when collapsed.
          collapsed ? "lg:w-16" : "lg:w-60",
        )}
        aria-label="Navegação principal"
      >
        {/* Logo row. On mobile we put a close button here; on desktop the
            close button is hidden since the sidebar is always-visible. */}
        <div
          className={cn(
            "flex h-12 shrink-0 items-center gap-2 border-b border-border px-4",
            collapsed ? "lg:justify-center lg:px-0" : "justify-between",
          )}
        >
          <Link
            href="/dashboard"
            className="flex items-center gap-2"
            title="FluxiaCRM"
          >
            <FluxiaMark className="h-7 w-7 shrink-0 text-primary" />
            <span
              className={cn(
                "text-sm font-semibold text-foreground",
                collapsed && "lg:hidden",
              )}
            >
              FluxiaCRM
            </span>
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar menu"
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="flex flex-col gap-1">
            {navItems
              .filter((item) => !item.adminOnly || canEditSettings)
              .filter((item) => !item.supervisorOnly || canViewDashboard)
              .map((item) => {
              const isActive =
                pathname === item.href ||
                (item.href !== "/dashboard" && pathname.startsWith(item.href));

              const showUnreadDot =
                item.href === "/inbox" && totalUnread > 0 && !isActive;

              // Unlike the inbox dot, the notifications count stays visible
              // even while the page is active — it reflects unread state
              // (cleared by marking notifications read), not "currently
              // viewing this section".
              const showNotificationBadge =
                item.href === "/notifications" && unreadNotifications > 0;

              // Red due-alert badge on Tarefas — stays visible even
              // while the page is active (it reflects work to do, not
              // "currently viewing"). Mirrors the notifications badge.
              const showTasksBadge =
                item.href === "/tarefas" && tasksDueAlert > 0;

              // A dot on Chat Interno when there are unread channels and the
              // user is elsewhere (mirrors the inbox dot).
              const showInternalDot =
                item.href === "/internal-chat" &&
                internalUnread > 0 &&
                !isActive;

              // When collapsed (icon rail), badges/labels are hidden — a
              // single dot on the icon signals "needs attention" instead.
              const hasBadge =
                showUnreadDot ||
                showNotificationBadge ||
                showTasksBadge ||
                showInternalDot;

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    title={collapsed ? item.label : undefined}
                    className={cn(
                      // Taller on mobile so fingers can hit the row reliably (≥44px).
                      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                      collapsed && "lg:justify-center lg:gap-0 lg:px-0",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <span className="relative flex shrink-0 items-center justify-center">
                      <item.icon className="h-4 w-4" />
                      {collapsed && hasBadge && (
                        <span className="absolute -right-1 -top-1 hidden h-2 w-2 rounded-full bg-primary ring-2 ring-card lg:block" />
                      )}
                    </span>
                    <span className={cn("flex-1", collapsed && "lg:hidden")}>
                      {item.label}
                    </span>
                    {item.beta && (
                      <span
                        aria-label="Recurso beta"
                        className={cn(
                          "rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300",
                          collapsed && "lg:hidden",
                        )}
                      >
                        Beta
                      </span>
                    )}
                    {showUnreadDot && (
                      <span
                        aria-label={`${totalUnread} conversa${totalUnread === 1 ? "" : "s"} não lida${totalUnread === 1 ? "" : "s"}`}
                        className={cn(
                          "relative flex h-2 w-2",
                          collapsed && "lg:hidden",
                        )}
                      >
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                      </span>
                    )}
                    {showNotificationBadge && (
                      <span
                        aria-label={`${unreadNotifications} notificação${unreadNotifications === 1 ? "" : "ões"} não lida${unreadNotifications === 1 ? "" : "s"}`}
                        className={cn(
                          "flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground",
                          collapsed && "lg:hidden",
                        )}
                      >
                        {unreadNotifications > 9 ? "9+" : unreadNotifications}
                      </span>
                    )}
                    {showTasksBadge && (
                      <span
                        aria-label={`${tasksDueAlert} tarefa${tasksDueAlert === 1 ? "" : "s"} vencida ou para hoje`}
                        className={cn(
                          "flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground",
                          collapsed && "lg:hidden",
                        )}
                      >
                        {tasksDueAlert > 9 ? "9+" : tasksDueAlert}
                      </span>
                    )}
                    {showInternalDot && (
                      <span
                        aria-label={`${internalUnread} canal${internalUnread === 1 ? "" : "is"} com mensagens não lidas`}
                        className={cn(
                          "relative flex h-2 w-2",
                          collapsed && "lg:hidden",
                        )}
                      >
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>

          <div className="my-4 border-t border-border" />

          <ul className="flex flex-col gap-1">
            {bottomNavItems.map((item) => {
              const isActive = pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    title={collapsed ? item.label : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                      collapsed && "lg:justify-center lg:gap-0 lg:px-0",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className={cn(collapsed && "lg:hidden")}>
                      {item.label}
                    </span>
                  </Link>
                </li>
              );
            })}

            {/* Collapse / expand toggle — desktop only (mobile uses the
                drawer). Gives the chat more room when collapsed. */}
            <li className="hidden lg:block">
              <button
                type="button"
                onClick={toggleCollapsed}
                title={collapsed ? "Expandir menu" : "Recolher menu"}
                aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  collapsed && "lg:justify-center lg:gap-0 lg:px-0",
                )}
              >
                {collapsed ? (
                  <PanelLeftOpen className="h-4 w-4 shrink-0" />
                ) : (
                  <PanelLeftClose className="h-4 w-4 shrink-0" />
                )}
                <span className={cn(collapsed && "lg:hidden")}>
                  Recolher menu
                </span>
              </button>
            </li>
          </ul>
        </nav>

        {/* User section */}
        <div className="shrink-0 border-t border-border p-3">
          {/* Account name display — surfaced only when the account
              name differs from the user's own name (see
              `showAccountStrip`). For a default solo account the two
              match, so we hide it to avoid duplicating the user name
              below; for renamed or shared accounts it tells the user
              which account they're acting in. */}
          {showAccountStrip && account?.name ? (
            <div
              className={cn(
                "mb-2 flex items-center gap-2 px-3 text-xs text-muted-foreground",
                collapsed && "lg:hidden",
              )}
            >
              <UsersRound className="size-3.5 shrink-0" />
              {/* `title=` exposes the full name on hover when it
                  gets truncated (long account names + narrow
                  sidebars). Cheap a11y win. */}
              <span className="truncate" title={account.name}>
                {account.name}
              </span>
              {accountRole ? (
                // Always render the chip — owners used to be
                // invisible here, which made them indistinguishable
                // from admins at a glance. Now everyone sees their
                // role (with a colour cue) regardless of tier.
                (() => {
                  const meta = ROLE_CHIP[accountRole];
                  const Icon = meta.icon;
                  return (
                    <span
                      className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${meta.className}`}
                    >
                      <Icon className="size-3" />
                      {meta.label}
                    </span>
                  );
                })()
              ) : null}
            </div>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              title={collapsed ? profile?.full_name ?? "Conta" : undefined}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:outline-none data-popup-open:bg-muted/60",
                collapsed && "lg:justify-center lg:px-0",
              )}
            >
              <Avatar className="size-8 shrink-0">
                {profile?.avatar_url ? (
                  <AvatarImage
                    src={profile.avatar_url}
                    alt={profile.full_name ?? "Avatar"}
                  />
                ) : null}
                <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
                  {profile?.full_name?.charAt(0)?.toUpperCase() ??
                    profile?.email?.charAt(0)?.toUpperCase() ??
                    "U"}
                </AvatarFallback>
              </Avatar>
              <div className={cn("min-w-0 flex-1", collapsed && "lg:hidden")}>
                <p className="truncate text-sm font-medium text-foreground">
                  {profile?.full_name ?? "Usuário"}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {profile?.email ?? ""}
                </p>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="top"
              sideOffset={6}
              className="min-w-56 bg-popover text-popover-foreground ring-border"
            >
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=profile"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <User className="size-4" />
                Perfil
              </DropdownMenuItem>
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=whatsapp"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <Settings className="size-4" />
                Configurações
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                onClick={signOut}
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <LogOut className="size-4" />
                Sair
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </>
  );
}
