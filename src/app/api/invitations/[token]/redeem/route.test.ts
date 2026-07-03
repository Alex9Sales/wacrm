import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// POST — accept an invitation. Requires a session. token = invitation id.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  userId: "user-1" as string | null,
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionUserId: vi.fn(async () => h.userId),
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      acceptInvitation: vi.fn(async () => ({
        member: { id: "member-1", role: "agent" },
        invitation: { id: "inv-1", status: "accepted" },
      })),
    },
  },
}));

import { POST } from "./route";
import { auth } from "@/lib/auth";

const ctx = { params: Promise.resolve({ token: "inv-1" }) };

beforeEach(() => {
  h.userId = "user-1";
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/invitations/[token]/redeem", () => {
  it("accepts the invitation for the logged-in user", async () => {
    const res = await POST(new Request("http://test.local"), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      member: { id: "member-1", role: "agent" },
      invitation: { id: "inv-1", status: "accepted" },
    });
    expect(auth.api.acceptInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ body: { invitationId: "inv-1" } }),
    );
  });

  it("returns 401 when there is no session", async () => {
    h.userId = null;
    const res = await POST(new Request("http://test.local"), ctx);
    expect(res.status).toBe(401);
    expect(auth.api.acceptInvitation).not.toHaveBeenCalled();
  });

  it("returns an error status when acceptInvitation throws", async () => {
    vi.mocked(auth.api.acceptInvitation).mockRejectedValueOnce(
      Object.assign(new Error("not recipient"), { statusCode: 403 }),
    );
    const res = await POST(new Request("http://test.local"), ctx);
    expect(res.status).toBe(403);
  });
});
