"use client";

import { useEffect } from "react";

import { isStaleActionError, reloadForStaleAction } from "@/lib/stale-action";

/**
 * Global recovery for the "stale bundle → missing Server Action" error that a
 * tab hits when it stayed open across a deploy. Listens for both uncaught
 * errors and unhandled promise rejections; when it sees that specific error it
 * reloads once (see reloadForStaleAction for the anti-loop guard) so the user
 * never gets stuck on a dead "Server Action was not found" screen.
 *
 * Components that catch the action error in their own try/catch should also
 * call reloadForStaleAction() there — a locally-caught error never reaches
 * these window listeners.
 */
export function StaleActionGuard() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      if (isStaleActionError(e.error ?? e.message)) reloadForStaleAction();
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isStaleActionError(e.reason)) reloadForStaleAction();
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
