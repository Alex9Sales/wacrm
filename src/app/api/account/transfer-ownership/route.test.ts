import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError } from "@/lib/auth/account";

// ---------------------------------------------------------------------------
// POST — transfer ownership. Owner-only. Promotes the target to owner
// and demotes the caller to admin via two updateMemberRole calls.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  // Map userId -> member row id for the mocked lookup.
  members: {
    "user-1": "member-caller",
    "user-2": "member-target",
  } as Record<string, string>,
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { updateMemberRole: vi.fn(async () => ({})) } },
}));

vi.mock("@/lib/auth/account", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/account")>();
  return {
    ...actual,
    requireRole: vi.fn(async () => ({
      userId: "user-1",
      accountId: "acct-1",
      role: "owner",
      account: { id: "acct-1", name: "Test" },
    })),
  };
});

vi.mock("@/db", () => {
  let pendingUserId: string | null = null;
  const chain: Record<string, unknown> = {
    select: () => chain,
    from: () => chain,
    where: (cond: { __userId?: string }) => {
      pendingUserId = cond?.__userId ?? null;
      return chain;
    },
    limit: async () => {
      const id = pendingUserId ? h.members[pendingUserId] : undefined;
      return id ? [{ id }] : [];
    },
  };
  // eq() is used in the route to build the where condition; capture the
  // userId argument so the mocked where() can resolve the right member.
  return { db: chain, member: {}, organization: {}, invitation: {}, user: {} };
});

// The route calls drizzle `and(eq(member.userId, userId), ...)`. To make the
// mocked where() see the userId, stub drizzle-orm's eq/and to thread it.
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ __col: col, __val: val }),
    and: (...conds: Array<{ __val?: unknown }>) => {
      // The first condition in the route is eq(member.userId, userId).
      const userId = conds[0]?.__val;
      return { __userId: typeof userId === "string" ? userId : undefined };
    },
  };
});

import { POST } from "./route";
import { auth } from "@/lib/auth";
import { requireRole } from "@/lib/auth/account";

function req(body?: unknown): Request {
  return new Request("http://test.local", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  h.members = { "user-1": "member-caller", "user-2": "member-target" };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/account/transfer-ownership", () => {
  it("promotes target to owner and demotes caller to admin", async () => {
    const res = await POST(req({ user_id: "user-2" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(auth.api.updateMemberRole).toHaveBeenCalledTimes(2);
    expect(auth.api.updateMemberRole).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        body: expect.objectContaining({ memberId: "member-target", role: "owner" }),
      }),
    );
    expect(auth.api.updateMemberRole).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        body: expect.objectContaining({ memberId: "member-caller", role: "admin" }),
      }),
    );
  });

  it("rejects a missing user_id with 400", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(auth.api.updateMemberRole).not.toHaveBeenCalled();
  });

  it("rejects transferring to self with 400", async () => {
    const res = await POST(req({ user_id: "user-1" }));
    expect(res.status).toBe(400);
    expect(auth.api.updateMemberRole).not.toHaveBeenCalled();
  });

  it("returns 404 when the target is not a member", async () => {
    const res = await POST(req({ user_id: "ghost" }));
    expect(res.status).toBe(404);
    expect(auth.api.updateMemberRole).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller is not owner", async () => {
    vi.mocked(requireRole).mockRejectedValueOnce(new ForbiddenError());
    const res = await POST(req({ user_id: "user-2" }));
    expect(res.status).toBe(403);
    expect(auth.api.updateMemberRole).not.toHaveBeenCalled();
  });
});
