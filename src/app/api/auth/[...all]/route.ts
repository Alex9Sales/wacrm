// ============================================================
// Better Auth catch-all handler — mounts every /api/auth/* route
// (sign-up, sign-in, sign-out, org create/invite/accept, …).
// ============================================================

import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth";

export const { GET, POST } = toNextJsHandler(auth);
