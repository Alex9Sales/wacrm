// Route disabled during the auth migration — see route.ts.
// TODO(fase-2): restore real coverage when invitations are
// reimplemented on Better Auth organizations.
import { describe, expect, it } from "vitest";

import { DELETE } from "./route";

describe("/api/account/invitations/[id] (disabled during Phase 2 auth migration)", () => {
  it("DELETE returns 501", async () => {
    const res = await DELETE(new Request("http://test.local"), {
      params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: "Temporarily disabled during auth migration (Phase 2)",
    });
  });
});
