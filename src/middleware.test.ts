import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { middleware } from "./middleware";

// Phase 1 middleware is a thin stub: it redirects the (now dead) auth
// pages to /dashboard and passes everything else through. Real session
// checks return in Phase 2 with Better Auth — these tests will grow then.

describe("middleware — Phase 1 stub", () => {
  it.each(["/login", "/signup", "/forgot-password"])(
    "redirects %s to /dashboard",
    async (path) => {
      const res = await middleware(new NextRequest(`https://app.test${path}`));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/dashboard");
    },
  );

  it.each(["/dashboard", "/inbox", "/contacts", "/api/whatsapp/send"])(
    "passes through %s without redirecting",
    async (path) => {
      const res = await middleware(new NextRequest(`https://app.test${path}`));
      expect(res.headers.get("location")).toBeNull();
    },
  );
});
