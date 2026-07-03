import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// GET — PUBLIC invitation peek. Reads the invitation row directly (no
// session, no Better Auth call), joined to organization for the name.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  row: {
    email: "invitee@x.dev",
    role: "agent",
    status: "pending",
    expiresAt: "2099-01-01T00:00:00.000Z",
    organizationName: "Fluxia Dev",
  } as Record<string, unknown> | null,
}));

vi.mock("@/db", () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => (h.row ? [h.row] : []),
  };
  return { db: chain, invitation: {}, organization: {} };
});

import { GET } from "./route";

const ctx = { params: Promise.resolve({ token: "inv-1" }) };

beforeEach(() => {
  h.row = {
    email: "invitee@x.dev",
    role: "agent",
    status: "pending",
    expiresAt: "2099-01-01T00:00:00.000Z",
    organizationName: "Fluxia Dev",
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/invitations/[token]/peek (public)", () => {
  it("returns non-sensitive invitation metadata", async () => {
    const res = await GET(new Request("http://test.local"), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      invitation: {
        email: "invitee@x.dev",
        role: "agent",
        status: "pending",
        expiresAt: "2099-01-01T00:00:00.000Z",
        organizationName: "Fluxia Dev",
      },
    });
  });

  it("returns 404 when the invitation does not exist", async () => {
    h.row = null;
    const res = await GET(new Request("http://test.local"), ctx);
    expect(res.status).toBe(404);
  });
});
