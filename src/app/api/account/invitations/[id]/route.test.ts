import { afterEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError } from "@/lib/auth/account";

// ---------------------------------------------------------------------------
// DELETE — cancel/revoke an invitation. Admin+.
// ---------------------------------------------------------------------------

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      cancelInvitation: vi.fn(async () => ({ id: "inv-1", status: "canceled" })),
    },
  },
}));

vi.mock("@/lib/auth/account", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/account")>();
  return {
    ...actual,
    requireRole: vi.fn(async () => ({
      userId: "user-1",
      accountId: "acct-1",
      role: "admin",
      account: { id: "acct-1", name: "Test" },
    })),
  };
});

import { DELETE } from "./route";
import { auth } from "@/lib/auth";
import { requireRole } from "@/lib/auth/account";

const ctx = { params: Promise.resolve({ id: "inv-1" }) };

afterEach(() => {
  vi.clearAllMocks();
});

describe("DELETE /api/account/invitations/[id]", () => {
  it("cancels the invitation", async () => {
    const res = await DELETE(new Request("http://test.local"), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(auth.api.cancelInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ body: { invitationId: "inv-1" } }),
    );
  });

  it("returns 403 when the caller is below admin", async () => {
    vi.mocked(requireRole).mockRejectedValueOnce(new ForbiddenError());
    const res = await DELETE(new Request("http://test.local"), ctx);
    expect(res.status).toBe(403);
    expect(auth.api.cancelInvitation).not.toHaveBeenCalled();
  });
});
