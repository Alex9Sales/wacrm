"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, RotateCw, X } from "lucide-react";

import { isEmbeddedSignupActive } from "@/lib/embedded-signup-flag";

// After the tab has been hidden this long, a RETURN with a new build in the
// air auto-recovers the stale bundle (reload) instead of only nudging with the
// banner. This is the "opened the laptop / came back after a while" case —
// where a stale tab otherwise hits "Failed to find Server Action" and looks
// frozen. A short alt-tab (below this) still just shows the banner.
const AUTO_RELOAD_AFTER_HIDDEN_MS = 30_000;

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
// without a manual hard-reload. Dismiss hides it until an even newer build
// ships. If a new build lands while the tab is away and the user then returns,
// we reload automatically (see AUTO_RELOAD_AFTER_HIDDEN_MS) so they never land
// on a stale, frozen page.
export function UpdateBanner({ initialBuildId }: { initialBuildId: string }) {
  const [latest, setLatest] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const checking = useRef(false);
  // When the tab last went hidden — to size how long the user was away.
  const hiddenSinceRef = useRef<number | null>(null);

  useEffect(() => {
    // Dormant in dev (no BUILD_ID) — nothing to compare against.
    if (!initialBuildId || initialBuildId === "dev") return;
    let stopped = false;

    const check = async (canAutoReload = false) => {
      if (checking.current || document.hidden) return;
      checking.current = true;
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { buildId?: string };
        if (stopped || typeof data.buildId !== "string") return;
        const build = data.buildId;
        const isNew = build !== initialBuildId;
        // Auto-recover a stale bundle: reload straight to the new build. A
        // stale tab is effectively BROKEN — every Server Action it fires hits
        // "Failed to find Server Action" and silently no-ops (delete, send,
        // etc. look like they "come back"), and most handlers catch that error
        // so the global listener below never sees it. So we don't wait for the
        // user to click the banner: any visible, idle tab that sees a newer
        // build reloads itself within the poll interval. Guarded so it's safe —
        // once per build (a mismatched /api/version can't loop), never while
        // typing a draft, never mid Embedded-Signup popup. `canAutoReload`
        // (return-from-away ≥30s) is kept only to force the check even in the
        // rare paths that pass it; the reload no longer depends on it.
        void canAutoReload;
        if (isNew && !isEditingDirtyText() && !isEmbeddedSignupActive()) {
          const guardKey = "fluxia:autoReloadedFor";
          if (sessionStorage.getItem(guardKey) !== build) {
            sessionStorage.setItem(guardKey, build);
            window.location.reload();
            return;
          }
        }
        // Reached only when we deliberately DIDN'T auto-reload (mid-draft or
        // mid-ES) — fall back to the manual "Nova versão" banner.
        setLatest(build);
      } catch {
        // offline / transient — try again on the next tick.
      } finally {
        checking.current = false;
      }
    };

    // Belt-and-suspenders for the stale bundle: if a click fires a Server
    // Action whose id changed across a deploy, Next throws "Failed to find
    // Server Action … older or newer deployment" and the page looks frozen.
    // The version poll only catches this on its 60s tick / on return-from-away;
    // a tab that stayed VISIBLE and gets clicked FIRST would still freeze. So
    // we also catch that exact error globally and reload immediately — time-
    // guarded (60s) so a non-bundle cause can never loop us.
    const STALE_ACTION_RE =
      /Failed to find Server Action|older or newer deployment/i;
    const reloadForStaleAction = (msg: unknown) => {
      if (typeof msg !== "string" || !STALE_ACTION_RE.test(msg)) return;
      // Never yank the page out from under an in-flight Embedded Signup popup.
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
    const id = window.setInterval(() => void check(), 60_000);
    const onVisibility = () => {
      if (document.hidden) {
        hiddenSinceRef.current = Date.now();
        return;
      }
      const awayMs = hiddenSinceRef.current
        ? Date.now() - hiddenSinceRef.current
        : 0;
      hiddenSinceRef.current = null;
      void check(awayMs >= AUTO_RELOAD_AFTER_HIDDEN_MS);
    };
    const onFocus = () => void check();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [initialBuildId]);

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
