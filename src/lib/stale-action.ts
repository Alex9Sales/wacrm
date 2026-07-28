// ============================================================
// Stale-bundle (Server Action) recovery.
//
// After a deploy, a tab left open still runs the OLD JS bundle. Any Server
// Action it calls references an action id that no longer exists on the new
// server, so Next.js throws "Failed to find Server Action …" / "Server Action
// … was not found on the server". The action never runs — nothing is saved —
// and the only fix is to reload and pick up the fresh bundle.
//
// These helpers detect that specific error and reload once (guarded so we can
// never loop). Used by the global <StaleActionGuard> for uncaught errors and
// by component catch blocks that handle the action error locally.
// ============================================================

/** True when `err` is the Next.js "stale bundle → missing Server Action" error. */
export function isStaleActionError(err: unknown): boolean {
  const text =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? `${err.message} ${err.stack ?? ""}`
        : typeof err === "object" && err !== null && "message" in err
          ? String((err as { message?: unknown }).message ?? "")
          : "";
  if (!text) return false;
  const m = text.toLowerCase();
  return (
    m.includes("failed-to-find-server-action") ||
    m.includes("older or newer deployment") ||
    (m.includes("server action") &&
      (m.includes("was not found") || m.includes("failed to find")))
  );
}

const RELOAD_GUARD_KEY = "fx:stale-reload-at";
const RELOAD_COOLDOWN_MS = 15_000;

/**
 * Reload once to pick up the new bundle. Returns true if a reload was issued.
 * Guarded via sessionStorage: if we already reloaded in the last few seconds
 * we do nothing, so a genuinely broken action can't put the tab in a reload
 * loop.
 */
export function reloadForStaleAction(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false;
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    // sessionStorage blocked (private mode / cookies off) — still reload once.
  }
  window.location.reload();
  return true;
}
