import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { middleware } from "./middleware";

// Phase 2 middleware (Better Auth): DB-free cookie-presence check.
//   - auth pages redirect to /dashboard ONLY when a session cookie is
//     present; otherwise they pass through.
//   - protected paths (/dashboard/**, authed /api/**) redirect to
//     /login (pages) or 401 (api) when the cookie is absent.
//   - public API prefixes (/api/auth, /api/webhooks) always pass.

// Better Auth's default cookie name (non-secure over http/test).
const SESSION_COOKIE = "better-auth.session_token";

function req(path: string, withSession = false): NextRequest {
  const r = new NextRequest(`https://app.test${path}`);
  if (withSession) {
    r.cookies.set(SESSION_COOKIE, "test-token.signature");
  }
  return r;
}

describe("middleware — Better Auth cookie gate", () => {
  it.each(["/login", "/signup", "/forgot-password"])(
    "redirects %s to /dashboard when a session cookie is present",
    async (path) => {
      const res = await middleware(req(path, true));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/dashboard");
    },
  );

  it.each(["/login", "/signup", "/forgot-password"])(
    "passes through %s when there is no session cookie",
    async (path) => {
      const res = await middleware(req(path, false));
      expect(res.headers.get("location")).toBeNull();
    },
  );

  it.each(["/dashboard", "/dashboard/inbox", "/api/whatsapp/send"])(
    "redirects/401s %s when there is no session cookie",
    async (path) => {
      const res = await middleware(req(path, false));
      if (path.startsWith("/api/")) {
        expect(res.status).toBe(401);
      } else {
        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toContain("/login");
      }
    },
  );

  it.each(["/dashboard", "/api/whatsapp/send"])(
    "passes through %s when a session cookie is present",
    async (path) => {
      const res = await middleware(req(path, true));
      expect(res.headers.get("location")).toBeNull();
      expect(res.status).not.toBe(401);
    },
  );

  it.each(["/api/auth/sign-in/email", "/api/webhooks/whatsapp", "/api/trial/signup"])(
    "always passes public API path %s without a cookie",
    async (path) => {
      const res = await middleware(req(path, false));
      expect(res.status).not.toBe(401);
      expect(res.headers.get("location")).toBeNull();
    },
  );
});
