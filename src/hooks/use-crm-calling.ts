"use client";

// Reactive read of the account-level "Tocar ligações no CRM" master switch
// (crmCallingEnabled). Fetches once on mount and refetches when the toggle
// changes in the same tab (CRM_CALLING_CHANGED_EVENT). Returns `true` until
// the first load resolves so the UI doesn't flicker the call affordances off.
//
// The call MODAL reads the same setting via a ref (it needs the value inside a
// non-reactive SSE handler); this hook is the reactive counterpart for render
// gating (e.g. hiding the outbound call button when calling is off).

import { useEffect, useState } from "react";

import { getCrmCallingEnabled } from "@/components/settings/actions";
import { CRM_CALLING_CHANGED_EVENT } from "@/lib/notifications/prefs";

export function useCrmCallingEnabled(): boolean {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getCrmCallingEnabled()
        .then((v) => {
          if (!cancelled) setEnabled(v);
        })
        .catch(() => {});
    void load();
    window.addEventListener(CRM_CALLING_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(CRM_CALLING_CHANGED_EVENT, load);
    };
  }, []);
  return enabled;
}
