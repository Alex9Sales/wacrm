// Route disabled during the auth migration — see route.ts.
// TODO(fase-2): restore real coverage when invitations are
// reimplemented on Better Auth organizations.
import { describe, expect, it } from "vitest";

import { GET, POST } from "./route";

describe("/api/account/invitations (disabled during Phase 2 auth migration)", () => {
  it("GET returns 501", async () => {
    const res = await GET();
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: "Temporarily disabled during auth migration (Phase 2)",
    });
  });

  it("POST returns 501", async () => {
    const res = await POST();
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: "Temporarily disabled during auth migration (Phase 2)",
    });
  });
});
