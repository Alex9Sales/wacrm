import { beforeEach, describe, expect, it, vi } from "vitest";

// getCurrentAccount resolves the caller's account context via two
// plain point queries (profiles by user_id, then accounts by id)
// through the shared Drizzle client. The session comes from the
// Phase 1 stub in ./session.

// ------------------------------------------------------------
// Mock state — hoisted so the vi.mock factories can close over it.
// `results` is a FIFO of row arrays, one entry per select query in
// call order (profiles first, accounts second).
// ------------------------------------------------------------
const state = vi.hoisted(() => ({
  results: [] as unknown[][],
  userId: null as string | null,
}));

vi.mock("./session", () => ({
  getSessionUserId: async () => state.userId,
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  const builder = {
    from: () => builder,
    where: () => builder,
    limit: async () => state.results.shift() ?? [],
  };
  return { ...actual, db: { select: () => builder } };
});

const { getCurrentAccount, UnauthorizedError, ForbiddenError } = await import(
  "./account"
);

beforeEach(() => {
  state.results = [];
  state.userId = null;
});

describe("getCurrentAccount", () => {
  it("resolves context from the profile and account point queries", async () => {
    state.userId = "user-1";
    state.results = [
      [{ accountId: "acct-1", accountRole: "owner" }],
      [{ id: "acct-1", name: "Acme" }],
    ];

    const ctx = await getCurrentAccount();

    expect(ctx).toEqual({
      userId: "user-1",
      accountId: "acct-1",
      role: "owner",
      account: { id: "acct-1", name: "Acme" },
    });
  });

  it("throws UnauthorizedError when there is no session", async () => {
    state.userId = null;
    await expect(getCurrentAccount()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a profile not linked to an account", async () => {
    state.userId = "user-1";
    state.results = [[{ accountId: null, accountRole: null }]];
    await expect(getCurrentAccount()).rejects.toThrow(
      "Profile is not linked to an account",
    );
  });

  it("rejects a missing profile row", async () => {
    state.userId = "user-1";
    state.results = [[]];
    const err = await getCurrentAccount().catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe("Profile is not linked to an account");
  });

  it("rejects an account role outside the TS enum", async () => {
    state.userId = "user-1";
    state.results = [[{ accountId: "acct-1", accountRole: "superuser" }]];
    await expect(getCurrentAccount()).rejects.toThrow(
      "Unknown account role: superuser",
    );
  });

  it("rejects an account_id that resolves to no account row", async () => {
    state.userId = "user-1";
    state.results = [
      [{ accountId: "acct-1", accountRole: "viewer" }],
      [],
    ];
    await expect(getCurrentAccount()).rejects.toThrow(
      "Profile is not linked to an account",
    );
  });
});
