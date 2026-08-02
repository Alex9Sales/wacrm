/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import {
  db,
  contacts,
  contactTags,
  conversations,
  flowNodes,
  flowRunEvents,
  flowRuns,
  flows as flowsTable,
  messages,
} from "@/db";
import { firstOrNull, firstOrThrow } from "@/db/helpers";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from "./meta-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
} from "./types";

// ============================================================
// Row mappings — the runner's row types (types.ts) are snake_case
// (they mirror the DB wire shape), so selects rename Drizzle's
// camelCase properties back to what the rest of the file expects.
// ============================================================

const flowRunSelection = {
  id: flowRuns.id,
  flow_id: flowRuns.flowId,
  account_id: flowRuns.accountId,
  user_id: flowRuns.userId,
  contact_id: flowRuns.contactId,
  conversation_id: flowRuns.conversationId,
  status: flowRuns.status,
  current_node_key: flowRuns.currentNodeKey,
  last_prompt_message_id: flowRuns.lastPromptMessageId,
  vars: flowRuns.vars,
  reprompt_count: flowRuns.repromptCount,
  started_at: flowRuns.startedAt,
  last_advanced_at: flowRuns.lastAdvancedAt,
  ended_at: flowRuns.endedAt,
  end_reason: flowRuns.endReason,
};

const flowSelection = {
  id: flowsTable.id,
  account_id: flowsTable.accountId,
  user_id: flowsTable.userId,
  name: flowsTable.name,
  description: flowsTable.description,
  status: flowsTable.status,
  trigger_type: flowsTable.triggerType,
  trigger_config: flowsTable.triggerConfig,
  entry_node_id: flowsTable.entryNodeId,
  channel_id: flowsTable.channelId,
  fallback_policy: flowsTable.fallbackPolicy,
  execution_count: flowsTable.executionCount,
  last_executed_at: flowsTable.lastExecutedAt,
  created_at: flowsTable.createdAt,
  updated_at: flowsTable.updatedAt,
};

const flowNodeSelection = {
  id: flowNodes.id,
  flow_id: flowNodes.flowId,
  node_key: flowNodes.nodeKey,
  node_type: flowNodes.nodeType,
  config: flowNodes.config,
  position_x: flowNodes.positionX,
  position_y: flowNodes.positionY,
  created_at: flowNodes.createdAt,
};

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a DB / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Text→option matcher for channels that can't render real interactive
 * buttons (WAHA & other unofficial providers). Those prompts go out as
 * numbered plain text (meta-send.ts `renderOptionsAsText`), so the
 * customer replies with a number ("2", "2.", "2)") or the option's
 * visible label. This maps that reply back to the option's
 * `next_node_key`. Label match wins over number so a label that happens
 * to start with a digit ("3 meses") still resolves to itself. Numbering
 * MUST stay in lockstep with the renderer: buttons 1..N in array order;
 * list rows 1..N flattened across sections in order. Returns null if
 * nothing matches.
 */
export function matchTextToButton(
  node: { node_type: string; config: Record<string, unknown> },
  text: string,
): string | null {
  const raw = text.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  // Leading number, tolerating "2", "2.", "2)", "2 -" etc.
  const numMatch = raw.match(/^(\d{1,3})\b/);
  const idx = numMatch ? parseInt(numMatch[1], 10) : NaN;

  if (node.node_type === "send_buttons") {
    const buttons = (node.config as unknown as SendButtonsNodeConfig).buttons ?? [];
    const byLabel = buttons.find((b) => b.title.trim().toLowerCase() === lower);
    if (byLabel) return byLabel.next_node_key;
    if (Number.isInteger(idx) && idx >= 1 && idx <= buttons.length) {
      return buttons[idx - 1].next_node_key;
    }
    return null;
  }
  if (node.node_type === "send_list") {
    const rows = ((node.config as unknown as SendListNodeConfig).sections ?? []).flatMap(
      (s) => s.rows ?? [],
    );
    const byLabel = rows.find((r) => r.title.trim().toLowerCase() === lower);
    if (byLabel) return byLabel.next_node_key;
    if (Number.isInteger(idx) && idx >= 1 && idx <= rows.length) {
      return rows[idx - 1].next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    node_type === "condition" ||
    node_type === "set_tag"
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

async function loadActiveRunForContact(
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one. .limit(1) is forgiving: pick the newest, let the
  // cron sweep clean up the stale one.
  try {
    const rows = (await db
      .select(flowRunSelection)
      .from(flowRuns)
      .where(
        and(
          eq(flowRuns.accountId, accountId),
          eq(flowRuns.contactId, contactId),
          eq(flowRuns.status, "active"),
        ),
      )
      .orderBy(desc(flowRuns.startedAt))
      .limit(1)) as unknown as FlowRunRow[];
    return rows[0] ?? null;
  } catch (error) {
    console.error(
      "[flows] loadActiveRunForContact error:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function loadFlow(flowId: string): Promise<FlowRow | null> {
  try {
    const row = firstOrNull(
      await db
        .select(flowSelection)
        .from(flowsTable)
        .where(eq(flowsTable.id, flowId))
        .limit(1),
    );
    return (row as unknown as FlowRow | null) ?? null;
  } catch (error) {
    console.error(
      "[flows] loadFlow error:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
async function loadAllNodes(flowId: string): Promise<Map<string, FlowNodeRow>> {
  let rows: FlowNodeRow[];
  try {
    rows = (await db
      .select(flowNodeSelection)
      .from(flowNodes)
      .where(eq(flowNodes.flowId, flowId))) as unknown as FlowNodeRow[];
  } catch (error) {
    console.error(
      "[flows] loadAllNodes error:",
      error instanceof Error ? error.message : error,
    );
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of rows) {
    map.set(row.node_key, row);
  }
  return map;
}

async function logEvent(
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.insert(flowRunEvents).values({
      flowRunId,
      eventType: event_type,
      nodeKey: node_key,
      payload,
    });
  } catch (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error(
      "[flows] logEvent error:",
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this account/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  try {
    // Fetch ALL run ids for this contact in this account (active +
    // historical). Bounded by how many flows the customer has been
    // through — small.
    const runs = await db
      .select({ id: flowRuns.id })
      .from(flowRuns)
      .where(
        and(eq(flowRuns.accountId, accountId), eq(flowRuns.contactId, contactId)),
      );
    if (!runs.length) return false;
    const runIds = runs.map((r) => r.id);

    const { n } = firstOrThrow(
      await db
        .select({ n: count() })
        .from(flowRunEvents)
        .where(
          and(
            inArray(flowRunEvents.flowRunId, runIds),
            eq(flowRunEvents.eventType, "reply_received"),
            sql`${flowRunEvents.payload}->>'meta_message_id' = ${metaMessageId}`,
          ),
        ),
    );
    return n > 0;
  } catch (error) {
    // Same semantics as before the Drizzle migration: a failed lookup
    // was treated as "not a duplicate".
    console.error(
      "[flows] isDuplicateInbound error:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

async function findEntryFlow(
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
  conversationChannelId: string | null,
): Promise<FlowRow | null> {
  // Only text messages can match an entry trigger. Interactive replies
  // are responses to existing prompts; they never start a new flow.
  if (message.kind !== "text") return null;

  // Pull all active flows for this account. Active set is bounded
  // (the builder discourages double-trigger overlap; partial index
  // makes the lookup index-supported).
  let typed: FlowRow[];
  try {
    typed = (await db
      .select(flowSelection)
      .from(flowsTable)
      .where(
        and(eq(flowsTable.accountId, accountId), eq(flowsTable.status, "active")),
      )
      .orderBy(asc(flowsTable.createdAt))) as unknown as FlowRow[];
  } catch {
    return null;
  }

  for (const flow of typed) {
    // Channel binding gate: a flow with channel_id set only fires on
    // inbounds that arrived on THAT channel. channel_id null = todos os
    // canais (legacy). If we couldn't resolve the conversation's channel,
    // only unbound flows may match (a bound flow can't be confirmed).
    if (flow.channel_id && flow.channel_id !== conversationChannelId) {
      continue;
    }
    if (flow.trigger_type === "keyword") {
      if (matchesKeywordTrigger(
        message.text,
        flow.trigger_config as KeywordTriggerConfig,
      )) {
        return flow;
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      return flow;
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }
  return null;
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

/**
 * Look up our internal message id for a Meta message id and stash it
 * on the run. Cheap — indexed on `messages.message_id`.
 */
async function stashPromptMessageId(
  runId: string,
  whatsappMessageId: string,
): Promise<void> {
  const msg = firstOrNull(
    await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.messageId, whatsappMessageId))
      .limit(1),
  );
  await db
    .update(flowRuns)
    .set({ lastPromptMessageId: msg?.id ?? null })
    .where(eq(flowRuns.id, runId));
}

async function sendButtonsAndSuspend(
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    buttons: cfg.buttons.map((b) => ({ id: b.reply_id, title: b.title })),
  });
  await logEvent(run.id, "message_sent", node.node_key, {
    node_type: "send_buttons",
    whatsapp_message_id,
  });
  await stashPromptMessageId(run.id, whatsapp_message_id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function sendListAndSuspend(
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    buttonLabel: cfg.button_label,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    sections: cfg.sections.map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: r.title,
        description: r.description,
      })),
    })),
  });
  await logEvent(run.id, "message_sent", node.node_key, {
    node_type: "send_list",
    whatsapp_message_id,
  });
  await stashPromptMessageId(run.id, whatsapp_message_id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function executeHandoff(run: FlowRunRow, node: FlowNodeRow): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  if (run.conversation_id) {
    // Post the internal note INTO the conversation thread so the attendant
    // who picks it up actually reads it. Before, the note only landed in
    // flow_run_events (the runs viewer) and was invisible in the inbox.
    // isInternal=true → shown to the team, never sent to the customer.
    const note = cfg.note?.trim();
    if (note) {
      try {
        await db.insert(messages).values({
          conversationId: run.conversation_id,
          senderType: "bot",
          contentType: "text",
          contentText: note,
          isInternal: true,
          status: "sent",
        });
      } catch (err) {
        console.error("[flows] handoff internal note insert failed:", err);
      }
    }
    const convUpdate: Partial<typeof conversations.$inferInsert> = {
      status: "pending",
      updatedAt: new Date().toISOString(),
    };
    // Assigning fires the `notify_conversation_assigned` DB trigger → the
    // agent gets a "Nova conversa atribuída" notification that deep-links to
    // this conversation (where the note now sits). No assignee → the
    // conversation just goes pending in the sector's queue.
    if (cfg.assign_to) convUpdate.assignedAgentId = cfg.assign_to;
    await db
      .update(conversations)
      .set(convUpdate)
      .where(eq(conversations.id, run.conversation_id));
  }
  await logEvent(run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
  });
  await endRun(run.id, "handed_off", "handoff_node");
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a DB mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
async function evaluateConditionNode(
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === "var") {
    const v = run.vars[cfg.subject_key];
    subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === "tag") {
    const { n } = firstOrThrow(
      await db
        .select({ n: count() })
        .from(contactTags)
        .where(
          and(
            eq(contactTags.contactId, run.contact_id!),
            eq(contactTags.tagId, cfg.subject_key),
          ),
        ),
    );
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    subjectValue = n > 0 ? cfg.subject_key : undefined;
  } else {
    const FIELD_COLUMNS = {
      name: contacts.name,
      email: contacts.email,
      phone: contacts.phone,
      company: contacts.company,
    } as const;
    const column = FIELD_COLUMNS[cfg.subject_key as keyof typeof FIELD_COLUMNS];
    if (!column) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    const row = firstOrNull(
      await db
        .select({ value: column })
        .from(contacts)
        .where(eq(contacts.id, run.contact_id!))
        .limit(1),
    );
    const raw = row?.value;
    subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

async function endRun(
  runId: string,
  status: "completed" | "handed_off" | "timed_out" | "failed",
  reason: string,
): Promise<void> {
  await db
    .update(flowRuns)
    .set({
      status,
      endedAt: new Date().toISOString(),
      endReason: reason,
    })
    .where(eq(flowRuns.id, runId));
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

async function advanceFromNodeKey(
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  let currentKey: string | null = startNodeKey;
  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(run.id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    await logEvent(run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars),
        });
        await logEvent(run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars)
            : undefined,
          filename: cfg.filename,
        });
        await logEvent(run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(run.id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "collect_input") {
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await logEvent(run.id, "message_sent", node.node_key, {
          node_type: "collect_input",
          whatsapp_message_id,
        });
        await stashPromptMessageId(run.id, whatsapp_message_id);
      } catch (err) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "collect_input_prompt_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(run.id, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await db
            .insert(contactTags)
            .values({ contactId: run.contact_id!, tagId: cfg.tag_id })
            .onConflictDoNothing({
              target: [contactTags.contactId, contactTags.tagId],
            });
        } else {
          await db
            .delete(contactTags)
            .where(
              and(
                eq(contactTags.contactId, run.contact_id!),
                eq(contactTags.tagId, cfg.tag_id),
              ),
            );
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_buttons") {
      await sendButtonsAndSuspend(run, node);
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      await sendListAndSuspend(run, node);
      const advanced = await advanceCurrentNodeKey(
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(run.id, "completed", node.node_key);
      await endRun(run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  try {
    const rows = await db
      .update(flowRuns)
      .set({
        currentNodeKey: newKey,
        lastAdvancedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(flowRuns.id, runId),
          eq(flowRuns.status, "active"),
          expectedOldKey === null
            ? isNull(flowRuns.currentNodeKey)
            : eq(flowRuns.currentNodeKey, expectedOldKey),
        ),
      )
      .returning({ id: flowRuns.id });
    return rows.length > 0;
  } catch (error) {
    console.error(
      "[flows] advanceCurrentNodeKey error:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
): Promise<DispatchInboundResult> {
  try {
    const activeRun = await loadActiveRunForContact(
      input.accountId,
      input.contactId,
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        input.accountId,
        input.contactId,
        input.message.meta_message_id,
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const nodes = await loadAllNodes(activeRun.flow_id);
      return handleReplyForActiveRun(activeRun, input.message, nodes);
    }

    // No active run → look for a flow whose entry trigger matches.
    // Resolve which channel this conversation arrived on so channel-bound
    // flows only fire on their channel. Null (legacy conv w/o channel_id)
    // → only unbound "todos os canais" flows will match.
    const convChannel = firstOrNull(
      await db
        .select({ channelId: conversations.channelId })
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .limit(1),
    );
    const flow = await findEntryFlow(
      input.accountId,
      input.message,
      input.isFirstInboundMessage,
      convChannel?.channelId ?? null,
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = await loadAllNodes(flow.id);
    return startNewRun(flow, input, nodes);
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

async function handleReplyForActiveRun(
  run: FlowRunRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  await logEvent(run.id, "reply_received", run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
  });

  if (!run.current_node_key) {
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(run.id, "failed", "active_run_missing_current_node");
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "no_match",
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(run.id, "failed", "current_node_not_found");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // Ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. Text reply on a send_buttons/send_list node — the WAHA/unofficial
  //      fallback, where the prompt went out as numbered text and the
  //      customer typed a number or the option's label.
  //   3. Text reply on a collect_input node — capture into vars.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  if (
    currentNode.node_type === "send_buttons" ||
    currentNode.node_type === "send_list"
  ) {
    if (message.kind === "interactive_reply") {
      matched = matchReplyId(currentNode, message.reply_id);
    } else if (message.kind === "text") {
      matched = matchTextToButton(currentNode, message.text);
    }
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "collect_input"
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    if (captured.length > 0 && cfg.var_key) {
      // Persist captured value + reset reprompt count atomically.
      const newVars = { ...run.vars, [cfg.var_key]: captured };
      try {
        await db
          .update(flowRuns)
          .set({
            vars: newVars,
            repromptCount: 0,
          })
          .where(eq(flowRuns.id, run.id));
        // Mirror the UPDATE in-memory so downstream interpolation in
        // the advance loop sees the captured var without us having to
        // re-SELECT the whole row.
        run.vars = newVars;
        run.reprompt_count = 0;
        await logEvent(run.id, "node_entered", currentNode.node_key, {
          captured_key: cfg.var_key,
          captured_length: captured.length,
        });
        matched = cfg.next_node_key;
      } catch {
        // Capture write failed — same as the old `if (!capErr)` guard:
        // leave `matched` null so the fallback policy handles the reply.
      }
    }
  }

  if (matched) {
    // Reset reprompt count on a successful match. Skip the write when
    // already 0 — the collect_input capture branch above already
    // zeroed it, and interactive-reply matches against a fresh run
    // (post-prior-reset) are also already 0. The previous re-read of
    // the whole row was needed only because we weren't mirroring the
    // capture UPDATE into the in-memory `run`; now that we do, the
    // local copy is the source of truth.
    if (run.reprompt_count !== 0) {
      try {
        await db
          .update(flowRuns)
          .set({ repromptCount: 0 })
          .where(eq(flowRuns.id, run.id));
        run.reprompt_count = 0;
      } catch {
        // Non-fatal — mirror of the old ignored-error semantics.
      }
    }
    const outcome = await advanceFromNodeKey(run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy.
  const policy = resolveFallbackPolicy(
    (await loadFlow(run.flow_id))?.fallback_policy,
  );
  const newReprompts = run.reprompt_count + 1;
  try {
    await db
      .update(flowRuns)
      .set({ repromptCount: newReprompts })
      .where(eq(flowRuns.id, run.id));
  } catch {
    // Non-fatal — mirror of the old ignored-error semantics.
  }

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(run.id, "fallback_fired", run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  if (action.type === "reprompt") {
    // Re-send the same prompt. Same node, no current_node_key change.
    if (currentNode.node_type === "send_buttons") {
      await sendButtonsAndSuspend(run, currentNode);
    } else if (currentNode.node_type === "send_list") {
      await sendListAndSuspend(run, currentNode);
    } else if (currentNode.node_type === "collect_input") {
      // Customer typed something we couldn't accept (empty after trim,
      // or var_key missing — rare). Re-send the prompt so they try again.
      const cfg = currentNode.config as unknown as CollectInputNodeConfig;
      try {
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      } catch (err) {
        await logEvent(run.id, "error", currentNode.node_key, {
          reason: "reprompt_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    if (run.conversation_id) {
      await db
        .update(conversations)
        .set({ status: "pending", updatedAt: new Date().toISOString() })
        .where(eq(conversations.id, run.conversation_id));
    }
    await logEvent(run.id, "handoff", run.current_node_key, {
      reason: "fallback_exhausted",
    });
    await endRun(run.id, "handed_off", "fallback_exhausted");
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  // action.type === 'end'
  await endRun(run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

/** pg unique_violation — raised by the partial unique index on concurrent starts. */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string; cause?: { code?: string } };
  if (e.code === "23505" || e.cause?.code === "23505") return true;
  const msg = e.message ?? "";
  return msg.includes("23505") || msg.includes("duplicate key");
}

async function startNewRun(
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
  let run: FlowRunRow;
  try {
    run = firstOrThrow(
      await db
        .insert(flowRuns)
        .values({
          flowId: flow.id,
          // Tenancy: NOT NULL post-017. The partial unique index
          // `idx_one_active_run_per_contact` is over (account_id,
          // contact_id) WHERE status='active', so two accounts sharing
          // a contact phone number each run their own flows independently.
          accountId: flow.account_id,
          // Audit: preserves the flow's author on the run row for log
          // attribution.
          userId: flow.user_id,
          contactId: input.contactId,
          conversationId: input.conversationId,
          status: "active",
          currentNodeKey: flow.entry_node_id,
        })
        .returning(flowRunSelection),
    ) as unknown as FlowRunRow;
  } catch (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    if (isUniqueViolation(insErr)) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error(
      "[flows] startNewRun insert error:",
      insErr instanceof Error ? insErr.message : insErr,
    );
    return { consumed: false, outcome: "no_match" };
  }
  await logEvent(run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic SQL function (migration 012) rather than read-modify-write:
  // two concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  try {
    await db.execute(sql`SELECT increment_flow_execution_count(${flow.id})`);
  } catch (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error(
      "[flows] execution_count rpc error:",
      incErr instanceof Error ? incErr.message : incErr,
    );
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}
