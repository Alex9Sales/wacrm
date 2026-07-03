// Route disabled during the auth migration — see route.ts.
// TODO(fase-2): restore real coverage when member management is
// reimplemented on Better Auth organizations.
import { describe, expect, it } from "vitest";

import { PATCH, DELETE } from "./route";

const ctx = { params: Promise.resolve({ userId: "00000000-0000-0000-0000-000000000000" }) };

describe("/api/account/members/[userId] (disabled during Phase 2 auth migration)", () => {
  it("PATCH returns 501", async () => {
    const res = await PATCH(new Request("http://test.local"), ctx);
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: "Temporarily disabled during auth migration (Phase 2)",
    });
  });

  it("DELETE returns 501", async () => {
    const res = await DELETE(new Request("http://test.local"), ctx);
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: "Temporarily disabled during auth migration (Phase 2)",
    });
  });
});
