import { afterEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError, UnauthorizedError } from "@/lib/auth/account";

// ---------------------------------------------------------------------------
// GET (list pending invites, any member) + POST (create invite, admin+).
// ---------------------------------------------------------------------------

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      listInvitations: vi.fn(async () => [
        { id: "inv-1", email: "a@x.dev", role: "agent", status: "pending" },
        { id: "inv-2", email: "b@x.dev", role: "agent", status: "accepted" },
        { id: "inv-3", email: "c@x.dev", role: "viewer", status: "canceled" },
      ]),
      createInvitation: vi.fn(async () => ({
        id: "inv-new",
        email: "new@x.dev",
        role: "agent",
        status: "pending",
      })),
    },
  },
}));

vi.mock("@/lib/auth/account", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/account")>();
  return {
    ...actual,
    getCurrentAccount: vi.fn(async () => ({
      userId: "user-1",
      accountId: "acct-1",
      role: "agent",
      account: { id: "acct-1", name: "Test" },
    })),
    requireRole: vi.fn(async () => ({
      userId: "user-1",
      accountId: "acct-1",
      role: "admin",
      account: { id: "acct-1", name: "Test" },
    })),
  };
});

import { GET, POST } from "./route";
import { auth } from "@/lib/auth";
import { getCurrentAccount, requireRole } from "@/lib/auth/account";

function req(body?: unknown): Request {
  return new Request("http://test.local", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/account/invitations", () => {
  it("returns only pending invitations for a member", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.invitations).toHaveLength(1);
    expect(json.invitations[0].id).toBe("inv-1");
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getCurrentAccount).mockRejectedValueOnce(new UnauthorizedError());
    const res = await GET();
    expect(res.status).toBe(401);
    expect(auth.api.listInvitations).not.toHaveBeenCalled();
  });
});

describe("POST /api/account/invitations", () => {
  it("creates an invitation and returns 201", async () => {
    const res = await POST(req({ email: "new@x.dev", role: "agent" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      invitation: {
        id: "inv-new",
        email: "new@x.dev",
        role: "agent",
        status: "pending",
      },
    });
    expect(auth.api.createInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { email: "new@x.dev", role: "agent" },
      }),
    );
  });

  it("rejects a missing email with 400", async () => {
    const res = await POST(req({ role: "agent" }));
    expect(res.status).toBe(400);
    expect(auth.api.createInvitation).not.toHaveBeenCalled();
  });

  it("rejects an invalid role with 400", async () => {
    const res = await POST(req({ email: "new@x.dev", role: "nope" }));
    expect(res.status).toBe(400);
    expect(auth.api.createInvitation).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller is below admin", async () => {
    vi.mocked(requireRole).mockRejectedValueOnce(new ForbiddenError());
    const res = await POST(req({ email: "new@x.dev", role: "agent" }));
    expect(res.status).toBe(403);
    expect(auth.api.createInvitation).not.toHaveBeenCalled();
  });
});
