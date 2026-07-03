// ============================================================
// Better Auth browser client.
//
// Used by auth pages (signup/login/forgot-password/join) and by
// use-auth.tsx's signOut. Mirrors the server plugin config so the
// typed org methods (create / setActive / invite / accept …) are
// available client-side with the same role/ac shapes.
// ============================================================

"use client";

import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

import { ac, roles } from "@/lib/permissions";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_SITE_URL ?? undefined,
  plugins: [
    organizationClient({
      ac,
      roles,
    }),
  ],
});
