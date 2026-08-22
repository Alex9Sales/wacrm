"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Sparkles, RotateCw, X } from "lucide-react";

import { isEmbeddedSignupActive } from "@/lib/embedded-signup-flag";

/** True when the user is mid-typing in a field with content — don't yank the
 *  page out from under a draft; show the banner instead. */
function isEditingDirtyText(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") {
    return !!(el as HTMLInputElement | HTMLTextAreaElement).value;
  }
  return false;
}

// "Nova versão disponível" banner. The server rendered this page from build
// `initialBuildId`; we poll /api/version and, when the running server reports
// a newer id, surface a one-click refresh so clients pick up new features
// without a manual hard-reload.
//
// A stale tab is effectively BROKEN: every Server Action it fires hits "Failed
// to find Server Action" and no-ops, AND a client-side navigation to a page
// added/changed by the new build renders the OLD component silently (no error
// to catch — e.g. a new button just doesn't appear). So we don't only nudge —
// we auto-reload a visible, idle tab that sees a newer build, and we re-check
// on three edges besides the 20s poll: return-from-hidden, window focus, and
// EVERY client-side route change (closes the "navigated on a stale bundle"
// gap that a plain interval leaves open for up to one tick). Guarded so it's
// safe: once per build, never while typing a draft, never mid Embedded-Signup.
export function UpdateBanner({ initialBuildId }: { initialBuildId: string }) {
  const [latest, setLatest] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const checking = useRef(false);
  const pathname = usePathname();

  const check = useCallback(async () => {
    // Dormant in dev (no BUILD_ID) — nothing to compare against.
    if (!initialBuildId || initialBuildId === "dev") return;
    if (checking.current || document.hidden) return;
    checking.current = true;
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { buildId?: string };
      if (typeof data.buildId !== "string") return;
      const build = data.buildId;
      if (build === initialBuildId) return;
      // Newer build in the air. Auto-recover unless it would clobber a draft
      // or an in-flight Embedded-Signup popup — then fall back to the banner.
      if (!isEditingDirtyText() && !isEmbeddedSignupActive()) {
        const guardKey = "fluxia:autoReloadedFor";
        if (sessionStorage.getItem(guardKey) !== build) {
          sessionStorage.setItem(guardKey, build);
          window.location.reload();
          return;
        }
      }
      setLatest(build);
    } catch {
      // offline / transient — try again on the next edge.
    } finally {
      checking.current = false;
    }
  }, [initialBuildId]);

  // Poll + focus/visibility + a global catch for the stale Server-Action error.
  useEffect(() => {
    if (!initialBuildId || initialBuildId === "dev") return;

    // Belt-and-suspenders: a click that fires a Server Action whose id changed
    // across a deploy throws "Failed to find Server Action … older or newer
    // deployment" and the page looks frozen. Catch that exact error globally
    // and reload immediately — time-guarded (60s) so a non-bundle cause can't
    // loop us.
    const STALE_ACTION_RE =
      /Failed to find Server Action|older or newer deployment/i;
    const reloadForStaleAction = (msg: unknown) => {
      if (typeof msg !== "string" || !STALE_ACTION_RE.test(msg)) return;
      if (isEmbeddedSignupActive()) return;
      const KEY = "fluxia:staleActionReloadAt";
      const last = Number(sessionStorage.getItem(KEY) || 0);
      if (Date.now() - last < 60_000) return; // just reloaded — don't loop
      sessionStorage.setItem(KEY, String(Date.now()));
      window.location.reload();
    };
    const onError = (e: ErrorEvent) =>
      reloadForStaleAction(e.message || (e.error as { message?: string })?.message);
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason as { message?: string } | string | undefined;
      reloadForStaleAction(typeof r === "string" ? r : r?.message);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    void check();
    // Poll agressivo (20s): detecta o deploy novo rápido e auto-recarrega a aba
    // ociosa antes de o usuário clicar numa ação de bundle velho.
    const id = window.setInterval(() => void check(), 20_000);
    const onVisibility = () => {
      if (!document.hidden) void check();
    };
    const onFocus = () => void check();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [initialBuildId, check]);

  // Re-check on EVERY client-side navigation. Landing on a page the new build
  // changed while running the old bundle renders the old component with no
  // error to catch (e.g. a just-added button is missing) — so we verify the
  // build the instant the route changes, not up to 20s later.
  useEffect(() => {
    void check();
  }, [pathname, check]);

  const hasUpdate =
    !!latest && latest !== initialBuildId && latest !== dismissed;
  if (!hasUpdate) return null;

  return (
    <div className="fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4">
      <div className="flex items-center gap-3 rounded-full border border-primary/30 bg-card/95 px-4 py-2.5 shadow-lg shadow-black/10 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Sparkles className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            Nova versão disponível
          </p>
          <p className="hidden text-xs text-muted-foreground sm:block">
            Atualize para pegar as últimas melhorias.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="ml-1 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <RotateCw className="size-3.5" />
          Atualizar
        </button>
        <button
          type="button"
          onClick={() => setDismissed(latest)}
          aria-label="Depois"
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
