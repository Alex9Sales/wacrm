import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError } from "@/lib/auth/account";

// ---------------------------------------------------------------------------
// PATCH (change role) + DELETE (remove member). Admin+ only.
// We mock the Better Auth `auth.api` methods and the account guard.
// The member table lookup (userId -> memberId) is mocked via @/db.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  memberRow: { id: "member-42" } as { id: string } | null,
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      updateMemberRole: vi.fn(async () => ({ id: "member-42", role: "admin" })),
      removeMember: vi.fn(async () => ({ member: { id: "member-42" } })),
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

vi.mock("@/db", () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => (h.memberRow ? [h.memberRow] : []),
  };
  return { db: chain, member: {}, organization: {}, invitation: {}, user: {} };
});

import { PATCH, DELETE } from "./route";
import { auth } from "@/lib/auth";
import { requireRole } from "@/lib/auth/account";

const ctx = {
  params: Promise.resolve({ userId: "00000000-0000-0000-0000-000000000000" }),
};

function req(body?: unknown): Request {
  return new Request("http://test.local", {
    method: "PATCH",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  h.memberRow = { id: "member-42" };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/account/members/[userId]", () => {
  it("updates a member's role and returns the result", async () => {
    const res = await PATCH(req({ role: "agent" }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ member: { id: "member-42", role: "admin" } });
    expect(auth.api.updateMemberRole).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ memberId: "member-42", role: "agent" }),
      }),
    );
  });

  it("rejects an invalid role with 400", async () => {
    const res = await PATCH(req({ role: "superadmin" }), ctx);
    expect(res.status).toBe(400);
    expect(auth.api.updateMemberRole).not.toHaveBeenCalled();
  });

  it("returns 404 when the target is not a member", async () => {
    h.memberRow = null;
    const res = await PATCH(req({ role: "agent" }), ctx);
    expect(res.status).toBe(404);
    expect(auth.api.updateMemberRole).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller is below admin", async () => {
    vi.mocked(requireRole).mockRejectedValueOnce(new ForbiddenError());
    const res = await PATCH(req({ role: "agent" }), ctx);
    expect(res.status).toBe(403);
    expect(auth.api.updateMemberRole).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/account/members/[userId]", () => {
  it("removes a member", async () => {
    const res = await DELETE(new Request("http://test.local"), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(auth.api.removeMember).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ memberIdOrEmail: "member-42" }),
      }),
    );
  });

  it("returns 404 when the target is not a member", async () => {
    h.memberRow = null;
    const res = await DELETE(new Request("http://test.local"), ctx);
    expect(res.status).toBe(404);
    expect(auth.api.removeMember).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller is below admin", async () => {
    vi.mocked(requireRole).mockRejectedValueOnce(new ForbiddenError());
    const res = await DELETE(new Request("http://test.local"), ctx);
    expect(res.status).toBe(403);
    expect(auth.api.removeMember).not.toHaveBeenCalled();
  });
});
