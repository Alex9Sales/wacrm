import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Platform-admin gate. isPlatformAdmin is a pure allowlist check;
// requirePlatformAdmin resolves the session → user email → allowlist.

const state = vi.hoisted(() => ({
  userId: null as string | null,
  rows: [] as unknown[][],
}));

vi.mock("./session", () => ({
  getSessionUserId: async () => state.userId,
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  const builder = {
    from: () => builder,
    where: () => builder,
    limit: async () => state.rows.shift() ?? [],
  };
  return { ...actual, db: { select: () => builder } };
});

const { isPlatformAdmin, requirePlatformAdmin } = await import("./platform");
const { UnauthorizedError, ForbiddenError } = await import("./account");

const ORIGINAL = process.env.PLATFORM_ADMIN_EMAILS;

beforeEach(() => {
  state.userId = null;
  state.rows = [];
  process.env.PLATFORM_ADMIN_EMAILS = "alex@fluxia.com, Ops@Fluxia.com ";
});

afterEach(() => {
  process.env.PLATFORM_ADMIN_EMAILS = ORIGINAL;
});

describe("isPlatformAdmin", () => {
  it("matches case-insensitively and trims whitespace", () => {
    expect(isPlatformAdmin("alex@fluxia.com")).toBe(true);
    expect(isPlatformAdmin("ALEX@FLUXIA.COM")).toBe(true);
    expect(isPlatformAdmin("  ops@fluxia.com  ")).toBe(true);
  });

  it("rejects non-listed and empty emails", () => {
    expect(isPlatformAdmin("someone@else.com")).toBe(false);
    expect(isPlatformAdmin("")).toBe(false);
    expect(isPlatformAdmin(null)).toBe(false);
    expect(isPlatformAdmin(undefined)).toBe(false);
  });

  it("is empty when the env var is unset", () => {
    process.env.PLATFORM_ADMIN_EMAILS = "";
    expect(isPlatformAdmin("alex@fluxia.com")).toBe(false);
  });
});

describe("requirePlatformAdmin", () => {
  it("throws UnauthorizedError with no session", async () => {
    state.userId = null;
    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("throws ForbiddenError when the email is off the allowlist", async () => {
    state.userId = "user-1";
    state.rows = [[{ email: "nobody@else.com" }]];
    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("resolves { userId, email } for an allowlisted admin", async () => {
    state.userId = "user-1";
    state.rows = [[{ email: "alex@fluxia.com" }]];
    await expect(requirePlatformAdmin()).resolves.toEqual({
      userId: "user-1",
      email: "alex@fluxia.com",
    });
  });
});
