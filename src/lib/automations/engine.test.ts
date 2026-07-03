import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared mock state for the Drizzle client. Lives in a hoisted block
// so the vi.mock factory below can close over it.
const h = vi.hoisted(() => ({
  state: {
    owned: null as { id: string } | null,
    ownedCustomField: null as { id: string } | null,
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    /** Table names hit by SELECTs, in order. */
    selectCalls: [] as string[],
    /** UPDATEs, with the WHERE clause rendered to SQL + params. */
    updateCalls: [] as { table: string; sql: string; params: unknown[] }[],
    /** INSERTs (including upserts), with the raw values payload. */
    insertCalls: [] as { table: string; payload: unknown }[],
  },
}));

vi.mock("@/db", async (importOriginal) => {
  // Keep the real schema exports (table + column objects) so the
  // engine's `eq(contacts.id, …)` conditions build real SQL we can
  // render and assert on; only the `db` client itself is mocked.
  const actual = await importOriginal<typeof import("@/db")>();
  const { getTableName } = await import("drizzle-orm");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const { state } = h;

  type AnyTable = Parameters<typeof getTableName>[0];
  type AnySql = Parameters<InstanceType<typeof PgDialect>["sqlToQuery"]>[0];

  function selectResult(table: string): unknown[] {
    if (table === "contacts") {
      // ownership guard / condition read
      return state.owned ? [state.owned] : [];
    }
    if (table === "custom_fields") {
      // account-scoped ownership lookup for a custom field definition
      return state.ownedCustomField ? [state.ownedCustomField] : [];
    }
    if (table === "automations") return state.automations;
    if (table === "automation_steps") return state.steps;
    if (table === "automation_logs") {
      return [{ steps_executed: [], status: "success" }];
    }
    if (table === "contact_tags") return [{ n: 0 }];
    if (table === "conversations") return [{ id: "conv1" }];
    if (table === "accounts") return [{ default_currency: "USD" }];
    return [];
  }

  function selectBuilder() {
    let table = "";
    const q = {
      from(t: unknown) {
        table = getTableName(t as AnyTable);
        state.selectCalls.push(table);
        return q;
      },
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        return Promise.resolve(selectResult(table)).then(onF, onR);
      },
    };
    return q;
  }

  function insertBuilder(t: unknown) {
    const table = getTableName(t as AnyTable);
    const q = {
      values(payload: unknown) {
        state.insertCalls.push({ table, payload });
        return q;
      },
      onConflictDoNothing: () => q,
      onConflictDoUpdate: () => q,
      returning: () =>
        Promise.resolve(table === "automation_logs" ? [{ id: "log1" }] : [{ id: "row1" }]),
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        return Promise.resolve([]).then(onF, onR);
      },
    };
    return q;
  }

  function updateBuilder(t: unknown) {
    const table = getTableName(t as AnyTable);
    const q = {
      set: () => q,
      where(cond: unknown) {
        const rendered = dialect.sqlToQuery(cond as AnySql);
        state.updateCalls.push({ table, sql: rendered.sql, params: rendered.params });
        return q;
      },
      returning: () => Promise.resolve([{ id: "row1" }]),
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        return Promise.resolve(undefined).then(onF, onR);
      },
    };
    return q;
  }

  function deleteBuilder() {
    const q = {
      where: () => q,
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        return Promise.resolve(undefined).then(onF, onR);
      },
    };
    return q;
  }

  const db = {
    select: () => selectBuilder(),
    insert: (t: unknown) => insertBuilder(t),
    update: (t: unknown) => updateBuilder(t),
    delete: () => deleteBuilder(),
    execute: () => Promise.resolve({ rows: [] }),
  };

  return { ...actual, db, getDb: () => db };
});

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
}));

import { runAutomationsForTrigger } from "./engine";

const ACCOUNT = "acct-1";

const contactUpdates = () => h.state.updateCalls.filter((u) => u.table === "contacts");
const customValueUpserts = () =>
  h.state.insertCalls.filter((i) => i.table === "contact_custom_values");

beforeEach(() => {
  h.state.owned = null;
  h.state.ownedCustomField = null;
  h.state.automations = [];
  h.state.steps = [];
  h.state.selectCalls = [];
  h.state.updateCalls = [];
  h.state.insertCalls = [];
});

describe("runAutomationsForTrigger — tenant isolation", () => {
  it("refuses to dispatch when the contact is not in the account (GHSA-63cv-2c49-m5v3)", async () => {
    // Ownership lookup returns nothing — the contact belongs to another tenant.
    h.state.owned = null;
    // If the guard failed, this automation would run an update_contact_field step.
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "victim-contact-uuid",
      context: { message_text: "manual trigger" },
    });

    // Bailed at the guard: never fetched automations, never wrote a contact.
    expect(h.state.selectCalls).toContain("contacts");
    expect(h.state.selectCalls).not.toContain("automations");
    expect(contactUpdates()).toHaveLength(0);
  });

  it("proceeds past the guard when the contact belongs to the account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = []; // no matching automations; just prove we got past the guard

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.selectCalls).toContain("automations");
  });

  it("scopes the update_contact_field write to the automation's account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    const updates = contactUpdates();
    expect(updates).toHaveLength(1);
    // The WHERE clause must pin both the contact id AND the tenant.
    expect(updates[0].sql).toContain('"contacts"."id"');
    expect(updates[0].sql).toContain('"contacts"."account_id"');
    expect(updates[0].params).toContain("c1");
    expect(updates[0].params).toContain(ACCOUNT);
  });
});

describe("update_contact_field — custom fields", () => {
  it("upserts contact_custom_values when the field is account-owned", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "Premium")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // No direct contacts column write for a custom field.
    expect(contactUpdates()).toHaveLength(0);
    const upserts = customValueUpserts();
    expect(upserts).toHaveLength(1);
    expect(upserts[0].payload).toEqual({
      contactId: "c1",
      customFieldId: "cf1",
      value: "Premium",
    });
  });

  it("interpolates {{ vars.* }} into the custom value", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "{{ vars.source }}")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { vars: { source: "WhatsApp Ad" } },
    });

    const upserts = customValueUpserts();
    expect(upserts).toHaveLength(1);
    expect((upserts[0].payload as { value: string }).value).toBe("WhatsApp Ad");
  });

  it("refuses to write a custom field from another account", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = null; // account-scoped lookup finds nothing
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:foreign-cf", "x")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(customValueUpserts()).toHaveLength(0);
    expect(contactUpdates()).toHaveLength(0);
  });
});

function automationWithUpdateStep() {
  return {
    id: "a1",
    account_id: ACCOUNT,
    user_id: "u1",
    trigger_type: "new_message_received",
    trigger_config: {},
    is_active: true,
  };
}

function updateStep() {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field: "company", value: "pwned-by-automation" },
  };
}

function customStep(field: string, value: string) {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field, value },
  };
}
