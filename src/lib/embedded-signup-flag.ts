// A tiny client-side singleton flag: "an Embedded Signup flow is in progress".
//
// The ES flow opens a Facebook popup and takes MINUTES; the opener (our CRM)
// tab sits hidden the whole time. The UpdateBanner's auto-reload-on-return
// would fire when the user comes back (tab hidden >30s + a new build shipped)
// and reload the opener — killing the FB.login callback that still has to POST
// the one-time `code`. So while a flow is active we suppress those reloads.
//
// Module-level state is a singleton across the client bundle, so the button
// (setter) and the banner (reader) share the same value without touching
// `window`. A safety timer clears it if the flow never calls back (popup
// closed with the X), so auto-reload can't be blocked forever.

let active = false;
let safety: ReturnType<typeof setTimeout> | null = null;

/** Longest an ES flow can reasonably take before we assume it was abandoned. */
const MAX_MS = 6 * 60_000;

export function setEmbeddedSignupActive(next: boolean): void {
  active = next;
  if (safety) {
    clearTimeout(safety);
    safety = null;
  }
  if (next) {
    safety = setTimeout(() => {
      active = false;
      safety = null;
    }, MAX_MS);
  }
}

export function isEmbeddedSignupActive(): boolean {
  return active;
}
