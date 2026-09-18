import { beforeEach, describe, expect, it, vi } from "vitest";

// findExistingContact queries through the shared Drizzle client —
// mock '@/db' with a fixed candidate set per test.
const state = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; phone: string }>,
  queried: false,
  inserted: [] as Array<{ phone: string }>,
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: async () => {
            state.queried = true;
            return state.rows;
          },
        }),
      }),
      insert: () => ({
        values: (vals: unknown) => {
          const arr = (Array.isArray(vals) ? vals : [vals]) as { phone: string }[];
          state.inserted.push(...arr);
          return {
            returning: async () =>
              arr.map((v, i) => ({ id: `new-${i}`, phone: v.phone })),
          };
        },
      }),
    },
  };
});

import {
  dedupeByPhone,
  findExistingContact,
  isExactMatch,
  isUniqueViolation,
  normalizeKey,
  resolveOrCreateContactIdsByPhone,
} from "./dedupe";

beforeEach(() => {
  state.rows = [];
  state.queried = false;
  state.inserted = [];
});

describe("resolveOrCreateContactIdsByPhone", () => {
  it("maps a Brazilian 9th-digit variant to the existing contact (no dup)", async () => {
    // Existing contact stored WITHOUT the extra 9; CSV imports it WITH the 9.
    state.rows = [{ id: "existing-paulo", phone: "556790001234" }];
    const out = await resolveOrCreateContactIdsByPhone("acct", "user", [
      { phone: "+5567990001234", name: "Paulo Exemplo" },
    ]);
    expect(out.get("+5567990001234")).toBe("existing-paulo");
    expect(state.inserted).toHaveLength(0); // never created a duplicate
  });

  it("collapses with/without-9 variants that appear in the same batch", async () => {
    state.rows = []; // neither exists yet
    const out = await resolveOrCreateContactIdsByPhone("acct", "user", [
      { phone: "556790001234" },
      { phone: "+5567990001234" },
    ]);
    // One insert, both input phones resolve to the same id.
    expect(state.inserted).toHaveLength(1);
    expect(out.get("556790001234")).toBe(out.get("+5567990001234"));
  });

  it("creates genuinely-different numbers separately", async () => {
    state.rows = [];
    const out = await resolveOrCreateContactIdsByPhone("acct", "user", [
      { phone: "556790001234" },
      { phone: "556790005678" },
    ]);
    expect(state.inserted).toHaveLength(2);
    expect(out.get("556790001234")).not.toBe(out.get("556790005678"));
  });
});

describe("normalizeKey", () => {
  it("strips every non-digit", () => {
    expect(normalizeKey("+1 (555) 123-4567")).toBe("15551234567");
    expect(normalizeKey("15551234567")).toBe("15551234567");
  });

  it("collapses different formats of the same number to one key", () => {
    expect(normalizeKey("+44 7911 123456")).toBe(normalizeKey("447911123456"));
  });
});

describe("isExactMatch", () => {
  it("treats different formatting of the same digits as exact", () => {
    expect(isExactMatch({ id: "1", phone: "+1 555-123-4567" }, "15551234567")).toBe(
      true,
    );
  });

  it("is false for a trunk-variant (fuzzy) match", () => {
    // last-8 match but not the same full number
    expect(isExactMatch({ id: "1", phone: "37061234567" }, "370061234567")).toBe(
      false,
    );
  });
});

describe("isUniqueViolation", () => {
  it("detects Postgres 23505", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });
  it("detects 23505 on a wrapped (Drizzle) error via cause", () => {
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
  });
  it("is false for other errors / non-objects", () => {
    expect(isUniqueViolation({ code: "23502" })).toBe(false);
    expect(isUniqueViolation({ cause: { code: "23502" } })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("boom")).toBe(false);
  });
});

describe("dedupeByPhone", () => {
  it("keeps the first occurrence and counts in-file duplicates", () => {
    const { unique, duplicates } = dedupeByPhone([
      { phone: "+1 555-1111", name: "A" },
      { phone: "15551111", name: "B" }, // same digits as #1
      { phone: "+1 555-2222", name: "C" },
    ]);
    expect(unique.map((r) => r.name)).toEqual(["A", "C"]);
    expect(duplicates).toBe(1);
  });

  it("drops rows with no digits", () => {
    const { unique, duplicates } = dedupeByPhone([
      { phone: "   " },
      { phone: "+1 555-3333" },
    ]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(1);
  });
});

describe("findExistingContact", () => {
  it("returns a trunk-variant match via phonesMatch", async () => {
    state.rows = [{ id: "c1", phone: "37061234567" }];
    const hit = await findExistingContact("acct", "+370 061 234 567");
    expect(hit?.id).toBe("c1");
  });

  it("returns null when no candidate matches", async () => {
    state.rows = [{ id: "c1", phone: "15559999999" }];
    const hit = await findExistingContact("acct", "+1 555-123-4567");
    expect(hit).toBeNull();
  });

  it("returns null for an empty phone without querying", async () => {
    state.rows = [{ id: "c1", phone: "15551234567" }];
    expect(await findExistingContact("acct", "   ")).toBeNull();
    expect(state.queried).toBe(false);
  });
});
