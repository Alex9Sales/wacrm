import { beforeEach, describe, expect, it, vi } from "vitest";

// getCurrentAccount (Better Auth model): session → userId, then the
// active organization + role. The primary path reads the Better Auth
// session/active-member; here we mock those to null so resolution takes
// the DB fallback: a `member` point query (organizationId + role),
// followed by an `organization` point query (id, name, default_currency).

// ------------------------------------------------------------
// Mock state — hoisted so the vi.mock factories can close over it.
// `results` is a FIFO of row arrays, one per select query in call
// order (member first, organization second).
// ------------------------------------------------------------
const state = vi.hoisted(() => ({
  results: [] as unknown[][],
  userId: null as string | null,
}));

vi.mock("./session", () => ({
  getSessionUserId: async () => state.userId,
}));

// Force resolveActiveOrg onto its DB fallback path by returning no
// active Better Auth session/member.
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () => null,
      getActiveMember: async () => null,
    },
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  const builder = {
    from: () => builder,
    where: () => builder,
    orderBy: () => builder,
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
  it("resolves context from the membership and organization queries", async () => {
    state.userId = "user-1";
    state.results = [
      [{ organizationId: "org-1", role: "owner" }],
      [{ id: "org-1", name: "Acme", defaultCurrency: "BRL" }],
    ];

    const ctx = await getCurrentAccount();

    expect(ctx).toEqual({
      userId: "user-1",
      accountId: "org-1",
      role: "owner",
      account: { id: "org-1", name: "Acme" },
      defaultCurrency: "BRL",
    });
  });

  it("throws UnauthorizedError when there is no session", async () => {
    state.userId = null;
    await expect(getCurrentAccount()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a user with no organization membership", async () => {
    state.userId = "user-1";
    state.results = [[]]; // no member row
    const err = await getCurrentAccount().catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe("User is not a member of any organization");
  });

  it("rejects a membership role outside the TS enum", async () => {
    state.userId = "user-1";
    state.results = [[{ organizationId: "org-1", role: "superuser" }]];
    await expect(getCurrentAccount()).rejects.toThrow(
      "Unknown account role: superuser",
    );
  });

  it("rejects an active org that resolves to no organization row", async () => {
    state.userId = "user-1";
    state.results = [
      [{ organizationId: "org-1", role: "viewer" }],
      [], // no organization row
    ];
    await expect(getCurrentAccount()).rejects.toThrow(
      "Active organization not found",
    );
  });
});
