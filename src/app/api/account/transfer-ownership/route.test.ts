// Route disabled during the auth migration — see route.ts.
// TODO(fase-2): restore real coverage when ownership transfer is
// reimplemented on Better Auth organizations.
import { describe, expect, it } from "vitest";

import { POST } from "./route";

describe("/api/account/transfer-ownership (disabled during Phase 2 auth migration)", () => {
  it("POST returns 501", async () => {
    const res = await POST();
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: "Temporarily disabled during auth migration (Phase 2)",
    });
  });
});
