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
  notifications,
} from "@/db";
import { firstOrNull, firstOrThrow } from "@/db/helpers";
import { and, asc, count, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
  engineSendTyping,
} from "./meta-send";

/** Small awaitable delay (AI-node typing pacing). */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Human-like "typing" pause before a message, scaled to its length and
 * clamped so a long reply doesn't stall the scheduler tick.
 */
function humanTypingDelayMs(text: string): number {
  return Math.min(2500, Math.max(600, text.length * 35));
}
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DelayNodeConfig,
  type JumpNodeConfig,
  type RandomizerNodeConfig,
  type HttpFetchNodeConfig,
  type WaitTimeoutConfig,
  type ActionNodeConfig,
  type AiNodeConfig,
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
import { runHttpFetch } from "./http-fetch";
import { generateFlowAiReply, splitIntoMessages } from "@/lib/ai/flow-agent";
import { getAccountSettings } from "@/lib/settings/account-settings";
import { aiHoursAllows } from "@/lib/ai/hours-gate";

/** Default quiet-time (s) before the AI node replies to a burst. */
const AI_DEFAULT_BUFFER_SECONDS = 6;
/** Default cap on AI replies per run before forcing a handoff. */
const AI_DEFAULT_MAX_TURNS = 6;

/** Debounce deadline ISO for an AI node's message buffer. */
function aiDebounceAtIso(cfg: AiNodeConfig): string {
  const raw = Number(cfg?.buffer_seconds);
  const seconds =
    Number.isFinite(raw) && raw > 0 ? raw : AI_DEFAULT_BUFFER_SECONDS;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

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
          // 'sleeping' (mid-drip) counts as a live run too: it must block a
          // NEW flow and must NOT be advanced as a reply — the caller branches
          // on `status`.
          inArray(flowRuns.status, ["active", "sleeping"]),
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
    | "delay_sleep"
    | "http_request"
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
  const cfg = node.config as {
    assign_to?: string;
    note?: string;
    customer_message?: string;
  };
  if (run.conversation_id) {
    // 1) Optional customer-facing message so the person isn't left hanging
    //    after picking an option ("Vou te transferir pra um atendente…").
    const customerMsg = cfg.customer_message?.trim();
    if (customerMsg) {
      try {
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id,
          contactId: run.contact_id!,
          text: customerMsg,
        });
      } catch (err) {
        console.error("[flows] handoff customer message failed:", err);
      }
    }

    // 2) Post the internal note INTO the conversation thread so the attendant
    //    who picks it up actually reads it (was only in flow_run_events).
    //    isInternal=true → shown to the team, never sent to the customer.
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

    // 3) Assign + notify. The `notify_conversation_assigned` DB trigger only
    //    fires when assigned_agent_id actually CHANGES, so a flow handing a
    //    conversation to the agent already on it wouldn't notify. Read the
    //    current assignee first: if our assignment is a no-op for the trigger,
    //    insert the notification ourselves so a handoff ALWAYS alerts the agent.
    const assignTo = cfg.assign_to || null;
    const convUpdate: Partial<typeof conversations.$inferInsert> = {
      status: "pending",
      updatedAt: new Date().toISOString(),
    };
    if (assignTo) convUpdate.assignedAgentId = assignTo;

    let triggerWillNotify = false;
    if (assignTo) {
      const current = firstOrNull(
        await db
          .select({ assignedAgentId: conversations.assignedAgentId })
          .from(conversations)
          .where(eq(conversations.id, run.conversation_id))
          .limit(1),
      );
      // Trigger fires only when the new assignee differs from the old one.
      triggerWillNotify = current?.assignedAgentId !== assignTo;
    }

    await db
      .update(conversations)
      .set(convUpdate)
      .where(eq(conversations.id, run.conversation_id));

    if (assignTo && !triggerWillNotify && run.contact_id) {
      // Trigger skipped (agent was already the assignee) — notify explicitly.
      try {
        const contact = firstOrNull(
          await db
            .select({ name: contacts.name, phone: contacts.phone })
            .from(contacts)
            .where(eq(contacts.id, run.contact_id))
            .limit(1),
        );
        const contactName =
          contact?.name?.trim() || contact?.phone || "um contato";
        await db.insert(notifications).values({
          accountId: run.account_id,
          userId: assignTo,
          type: "conversation_assigned",
          conversationId: run.conversation_id,
          contactId: run.contact_id,
          title: "Nova conversa atribuída",
          body: `Você recebeu uma conversa com ${contactName}`,
        });
      } catch (err) {
        console.error("[flows] handoff notification insert failed:", err);
      }
    }
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

/** Anti-loop cap: total `jump` node traversals allowed per run before we fail
 *  it. Generous enough for legit drip cycles (adiar→30d→jump), low enough that
 *  a misconfigured loop can't run forever. */
const MAX_JUMPS_PER_RUN = 25;

async function advanceFromNodeKey(
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" | "sleeping" }> {
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
        computeTimeoutAtIso(cfg.timeout),
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
    if (node.node_type === "action") {
      const cfg = node.config as unknown as ActionNodeConfig;
      for (const op of cfg.operations ?? []) {
        try {
          if (op.type === "set_field") {
            // Only the standard editable fields — never phone (the identity
            // key) or arbitrary columns.
            if (
              run.contact_id &&
              (op.field === "name" ||
                op.field === "email" ||
                op.field === "company")
            ) {
              const value = interpolateVars(op.value ?? "", run.vars);
              const patch: Partial<typeof contacts.$inferInsert> = {
                updatedAt: new Date().toISOString(),
              };
              if (op.field === "name") patch.name = value;
              else if (op.field === "email") patch.email = value;
              else patch.company = value;
              await db
                .update(contacts)
                .set(patch)
                .where(eq(contacts.id, run.contact_id));
            }
          } else if (op.type === "add_tag") {
            // No tag_added dispatch here — same as set_tag, avoids
            // flow-triggers-flow recursion.
            if (run.contact_id && op.tag_id) {
              await db
                .insert(contactTags)
                .values({ contactId: run.contact_id, tagId: op.tag_id })
                .onConflictDoNothing({
                  target: [contactTags.contactId, contactTags.tagId],
                });
            }
          } else if (op.type === "remove_tag") {
            if (run.contact_id && op.tag_id) {
              await db
                .delete(contactTags)
                .where(
                  and(
                    eq(contactTags.contactId, run.contact_id),
                    eq(contactTags.tagId, op.tag_id),
                  ),
                );
            }
          } else if (op.type === "notify") {
            // Recipient: the chosen agent, else the conversation's current
            // assignee. No assignee + no pick → skip (no team-wide target).
            let recipient = op.assign_to || null;
            if (!recipient && run.conversation_id) {
              const conv = firstOrNull(
                await db
                  .select({ assignedAgentId: conversations.assignedAgentId })
                  .from(conversations)
                  .where(eq(conversations.id, run.conversation_id))
                  .limit(1),
              );
              recipient = conv?.assignedAgentId ?? null;
            }
            if (recipient) {
              await db.insert(notifications).values({
                accountId: run.account_id,
                userId: recipient,
                type: "flow_notification",
                conversationId: run.conversation_id ?? undefined,
                contactId: run.contact_id ?? undefined,
                title: "Aviso do fluxo",
                body:
                  interpolateVars(op.message ?? "", run.vars) ||
                  "Um fluxo pediu sua atenção.",
              });
            }
          }
        } catch (err) {
          // Non-fatal — one bad op shouldn't strand the run. Log + continue.
          await logEvent(run.id, "error", node.node_key, {
            reason: "action_op_failed",
            op_type: op.type,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await logEvent(run.id, "node_entered", node.node_key, {
        ops: (cfg.operations ?? []).length,
      });
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "ai") {
      // Hand the conversation to the AI agent. Park here and arm the
      // debounce; the scheduler's AI branch generates + sends the reply
      // once the buffer goes quiet, then loops (re-parks) or exits.
      const cfg = node.config as unknown as AiNodeConfig;
      const advanced = await advanceCurrentNodeKey(
        run.id,
        run.current_node_key,
        node.node_key,
        aiDebounceAtIso(cfg),
      );
      if (!advanced) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      await logEvent(run.id, "node_entered", node.node_key, {
        node_type: "ai",
      });
      return { outcome: "advanced" };
    }
    if (node.node_type === "jump") {
      const cfg = node.config as unknown as JumpNodeConfig;
      // Anti-loop: cap total jumps per run. A drip cycle (…→ delay → jump back)
      // is legit, but must not spin forever. Counter lives in vars so it
      // survives the delays/suspensions between jumps.
      const jumps =
        (typeof run.vars.__jump_count === "number" ? run.vars.__jump_count : 0) +
        1;
      if (jumps > MAX_JUMPS_PER_RUN) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "jump_limit_exceeded",
          jumps,
        });
        await endRun(run.id, "failed", "jump_limit_exceeded");
        return { outcome: "completed" };
      }
      const newVars = { ...run.vars, __jump_count: jumps };
      try {
        await db
          .update(flowRuns)
          .set({ vars: newVars })
          .where(eq(flowRuns.id, run.id));
        run.vars = newVars;
      } catch (err) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "jump_counter_persist_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      await logEvent(run.id, "node_entered", node.node_key, {
        jump_to: cfg.target_node_key,
        jump_count: jumps,
      });
      currentKey = cfg.target_node_key;
      continue;
    }
    if (node.node_type === "randomizer") {
      const cfg = node.config as unknown as RandomizerNodeConfig;
      const branches = (cfg.branches ?? []).filter((b) => b.next_node_key);
      const total = branches.reduce(
        (s, b) => s + Math.max(0, Number(b.weight) || 0),
        0,
      );
      if (branches.length === 0 || total <= 0) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "randomizer_no_branches",
        });
        await endRun(run.id, "failed", "randomizer_no_branches");
        return { outcome: "completed" };
      }
      // Weighted pick. Math.random() is fine here (engine runs in the app,
      // not the deterministic workflow sandbox).
      let r = Math.random() * total;
      let chosen = branches[branches.length - 1];
      for (const b of branches) {
        r -= Math.max(0, Number(b.weight) || 0);
        if (r <= 0) {
          chosen = b;
          break;
        }
      }
      await logEvent(run.id, "node_entered", node.node_key, {
        branch: chosen.id,
      });
      currentKey = chosen.next_node_key;
      continue;
    }
    if (node.node_type === "http_fetch") {
      const cfg = node.config as unknown as HttpFetchNodeConfig;
      const result = await runHttpFetch(cfg, run.vars);
      // Store the response under a var prefix so later nodes can branch
      // on the status / interpolate the body. Reject unsafe var keys.
      const saveTo =
        cfg.save_to && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cfg.save_to)
          ? cfg.save_to
          : "http";
      const newVars: Record<string, unknown> = {
        ...run.vars,
        [saveTo]: result.bodyText,
        [`${saveTo}_status`]: result.status,
      };
      if (result.ok) {
        delete newVars[`${saveTo}_error`];
      } else {
        newVars[`${saveTo}_error`] = result.error ?? "erro";
      }
      await db
        .update(flowRuns)
        .set({ vars: newVars })
        .where(eq(flowRuns.id, run.id));
      run.vars = newVars;
      await logEvent(run.id, "http_request", node.node_key, {
        status: result.status,
        ok: result.ok,
        error: result.error,
      });
      // Success → next; failure → error branch when wired, else fall
      // through to next so an optional enrichment call can't dead-end.
      currentKey = result.ok
        ? cfg.next_node_key
        : cfg.error_node_key || cfg.next_node_key;
      continue;
    }
    if (node.node_type === "delay") {
      const cfg = node.config as unknown as DelayNodeConfig;
      const resumeAtIso = computeResumeAtIso(cfg);
      // Persist WHERE to resume (the delay's next node) + WHEN, then sleep.
      // The scheduler worker (resumeSleepingRuns) wakes it once due — so a
      // delay of days survives restarts. Optimistic on current_node_key so a
      // racing dispatch doesn't double-sleep.
      const slept = await sleepRun(
        run.id,
        run.current_node_key,
        cfg.next_node_key,
        resumeAtIso,
      );
      if (!slept) {
        await logEvent(run.id, "error", node.node_key, {
          reason: "lost_race_during_sleep",
        });
        return { outcome: "advanced" };
      }
      await logEvent(run.id, "delay_sleep", node.node_key, {
        resume_at: resumeAtIso,
        duration: cfg.duration,
      });
      return { outcome: "sleeping" };
    }
    if (node.node_type === "send_buttons") {
      await sendButtonsAndSuspend(run, node);
      // Persist the new current_node_key via optimistic UPDATE, arming the
      // no-reply timeout deadline (null when the node has no timeout).
      const advanced = await advanceCurrentNodeKey(
        run.id,
        run.current_node_key,
        node.node_key,
        computeTimeoutAtIso(
          (node.config as unknown as SendButtonsNodeConfig).timeout,
        ),
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
        computeTimeoutAtIso(
          (node.config as unknown as SendListNodeConfig).timeout,
        ),
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
  timeoutAtIso: string | null = null,
): Promise<boolean> {
  try {
    const rows = await db
      .update(flowRuns)
      .set({
        currentNodeKey: newKey,
        lastAdvancedAt: new Date().toISOString(),
        // Always (re)stamp the timeout so a run parking at a new suspending
        // node never inherits the previous node's stale deadline.
        timeoutAt: timeoutAtIso,
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

/**
 * Deadline ISO for a suspending node's no-reply timeout, or null when the
 * node has no (valid) timeout. A non-positive / malformed duration yields
 * null so a mis-authored timeout never traps the run instantly.
 */
function computeTimeoutAtIso(
  timeout: WaitTimeoutConfig | undefined,
): string | null {
  if (!timeout || !timeout.timeout_node_key) return null;
  const value = Number(timeout.duration?.value);
  const unit = timeout.duration?.unit ?? "minutes";
  if (!Number.isFinite(value) || value <= 0) return null;
  const perUnitSeconds = unit === "days" ? 86400 : unit === "hours" ? 3600 : 60;
  return new Date(Date.now() + value * perUnitSeconds * 1000).toISOString();
}

/**
 * Wall-clock ISO of when a delay should wake. Clamps negatives to now.
 * When the node has `business_hours`, the base (now + duration) is then
 * rolled forward to the next moment inside the daily window — so a drip
 * message that would land at 3am waits until the window opens.
 */
function computeResumeAtIso(cfg: DelayNodeConfig): string {
  const duration = cfg?.duration;
  const value = Number(duration?.value);
  const unit = duration?.unit ?? "minutes";
  const perUnitSeconds = unit === "days" ? 86400 : unit === "hours" ? 3600 : 60;
  const ms =
    Math.max(0, Number.isFinite(value) ? value : 0) * perUnitSeconds * 1000;
  const base = new Date(Date.now() + ms);
  const bh = cfg?.business_hours;
  if (!bh) return base.toISOString();
  return rollIntoBusinessHours(base, bh).toISOString();
}

// ---- business-hours ("Atraso Inteligente") helpers ----

const DOW_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Local calendar parts of an instant, as seen in `tz`. */
function getZonedParts(
  date: Date,
  tz: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dow: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  return {
    year: Number(m.year),
    month: Number(m.month),
    day: Number(m.day),
    hour: Number(m.hour),
    minute: Number(m.minute),
    dow: DOW_MAP[m.weekday] ?? 0,
  };
}

/**
 * UTC instant for a given wall-clock (year/month/day + minutes-of-day) in
 * `tz`. Uses the tz offset at that instant, so it's DST-correct except
 * within the ~1h transition overlap — fine for scheduling a drip resume.
 */
function zonedWallToUtc(
  year: number,
  month: number,
  day: number,
  minutesOfDay: number,
  tz: string,
): Date {
  const h = Math.floor(minutesOfDay / 60);
  const mi = minutesOfDay % 60;
  const asUtc = Date.UTC(year, month - 1, day, h, mi, 0);
  // Offset between the tz wall-clock and UTC at (approximately) this instant.
  const p = getZonedParts(new Date(asUtc), tz);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  const offset = wallAsUtc - asUtc;
  return new Date(asUtc - offset);
}

/** "HH:MM" → minutes-of-day, or null when malformed / out of range. */
function parseHHMM(s: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * Roll `base` forward to the next instant inside the business-hours
 * window. Fails open (returns `base` unchanged) for a degenerate config
 * — invalid times, end ≤ start (no overnight windows), or no days — so a
 * misconfigured window never traps a run.
 */
export function rollIntoBusinessHours(
  base: Date,
  bh: NonNullable<DelayNodeConfig["business_hours"]>,
): Date {
  const tz = bh.timezone || "America/Sao_Paulo";
  const sMin = parseHHMM(bh.start);
  const eMin = parseHHMM(bh.end);
  const days = Array.isArray(bh.days)
    ? bh.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    : [];
  if (sMin === null || eMin === null || eMin <= sMin || days.length === 0) {
    return base;
  }
  let cursor = base;
  // At most 21 hops (3 weeks) — a safety cap; valid configs converge in ≤7.
  for (let i = 0; i < 21; i += 1) {
    const p = getZonedParts(cursor, tz);
    const localMin = p.hour * 60 + p.minute;
    const dayOk = days.includes(p.dow);
    if (dayOk && localMin >= sMin && localMin < eMin) {
      return cursor; // already inside a window
    }
    if (dayOk && localMin < sMin) {
      return zonedWallToUtc(p.year, p.month, p.day, sMin, tz); // opens later today
    }
    // Day not allowed, or today's window already closed → jump to the
    // start of the next calendar day and re-evaluate. Anchoring on sMin
    // then +24h side-steps month/DST rollover; the loop self-corrects.
    const anchor = zonedWallToUtc(p.year, p.month, p.day, sMin, tz);
    cursor = new Date(anchor.getTime() + 24 * 3600 * 1000);
  }
  return base;
}

/**
 * Put a run to sleep on a `delay` node: status → 'sleeping', stamp resume_at,
 * and move current_node_key to the delay's next node so the worker resumes
 * PAST the delay (not back into it). Optimistic on (status='active',
 * current_node_key) so a concurrent dispatch can't double-sleep the run.
 */
async function sleepRun(
  runId: string,
  expectedOldKey: string | null,
  nextKey: string,
  resumeAtIso: string,
): Promise<boolean> {
  try {
    const rows = await db
      .update(flowRuns)
      .set({
        status: "sleeping",
        currentNodeKey: nextKey,
        resumeAt: resumeAtIso,
        // A sleeping (drip) run isn't awaiting a reply — drop any timeout.
        timeoutAt: null,
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
      "[flows] sleepRun error:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/**
 * Resume every drip run whose delay has elapsed. Called on a timer by the
 * flows scheduler worker. Claims each due run atomically (sleeping → active
 * via a conditional UPDATE) so overlapping ticks never double-process, then
 * walks it forward from where the delay left off.
 */
export async function resumeSleepingRuns(
  limit = 100,
): Promise<{ resumed: number }> {
  const nowIso = new Date().toISOString();
  let due: FlowRunRow[];
  try {
    due = (await db
      .select(flowRunSelection)
      .from(flowRuns)
      .where(and(eq(flowRuns.status, "sleeping"), lte(flowRuns.resumeAt, nowIso)))
      .orderBy(asc(flowRuns.resumeAt))
      .limit(limit)) as unknown as FlowRunRow[];
  } catch (err) {
    console.error(
      "[flows] resumeSleepingRuns query error:",
      err instanceof Error ? err.message : err,
    );
    return { resumed: 0 };
  }

  let resumed = 0;
  for (const run of due) {
    // Claim: only one worker/tick wins the sleeping → active flip.
    let claimed = false;
    try {
      const rows = await db
        .update(flowRuns)
        .set({
          status: "active",
          resumeAt: null,
          // Defensive: a re-suspend downstream re-arms it; never resume with
          // a stale deadline.
          timeoutAt: null,
          lastAdvancedAt: new Date().toISOString(),
        })
        .where(and(eq(flowRuns.id, run.id), eq(flowRuns.status, "sleeping")))
        .returning({ id: flowRuns.id });
      claimed = rows.length > 0;
    } catch {
      claimed = false;
    }
    if (!claimed) continue;

    try {
      if (!run.current_node_key) {
        await endRun(run.id, "failed", "resume_missing_current_node");
        continue;
      }
      const nodes = await loadAllNodes(run.flow_id);
      await advanceFromNodeKey(
        { ...run, status: "active" },
        run.current_node_key,
        nodes,
      );
      resumed += 1;
    } catch (err) {
      console.error(
        "[flows] resume advance failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { resumed };
}

/**
 * Fire the no-reply timeout on every active run whose deadline has passed.
 * Runs on the same scheduler tick as resumeSleepingRuns. For each due run:
 * re-read the parked node's timeout target, atomically claim the transition
 * (CAS on current_node_key so a reply that landed first wins the race and
 * this becomes a no-op), then walk forward down the timeout path.
 */
export async function resumeTimedOutRuns(
  limit = 100,
): Promise<{ fired: number }> {
  const nowIso = new Date().toISOString();
  let due: FlowRunRow[];
  try {
    due = (await db
      .select(flowRunSelection)
      .from(flowRuns)
      .where(
        and(eq(flowRuns.status, "active"), lte(flowRuns.timeoutAt, nowIso)),
      )
      .orderBy(asc(flowRuns.timeoutAt))
      .limit(limit)) as unknown as FlowRunRow[];
  } catch (err) {
    console.error(
      "[flows] resumeTimedOutRuns query error:",
      err instanceof Error ? err.message : err,
    );
    return { fired: 0 };
  }

  let fired = 0;
  for (const run of due) {
    const parkedKey = run.current_node_key;
    if (!parkedKey) {
      // Malformed — clear the deadline so it stops being re-selected.
      try {
        await db
          .update(flowRuns)
          .set({ timeoutAt: null })
          .where(eq(flowRuns.id, run.id));
      } catch {
        // ignore
      }
      continue;
    }
    try {
      const nodes = await loadAllNodes(run.flow_id);
      const node = nodes.get(parkedKey) ?? null;

      // AI node: the deadline is a message-buffer debounce, not a no-reply
      // timeout. Claim it (CAS on current_node_key AND that the deadline is
      // still due — a fresh inbound that re-armed it into the future loses
      // here and re-fires next tick) then generate the reply.
      if (node?.node_type === "ai") {
        const claimed = await db
          .update(flowRuns)
          .set({ timeoutAt: null, lastAdvancedAt: new Date().toISOString() })
          .where(
            and(
              eq(flowRuns.id, run.id),
              eq(flowRuns.status, "active"),
              eq(flowRuns.currentNodeKey, parkedKey),
              lte(flowRuns.timeoutAt, nowIso),
            ),
          )
          .returning({ id: flowRuns.id });
        if (claimed.length === 0) continue;
        await runAiTurn({ ...run, status: "active" }, node, nodes);
        fired += 1;
        continue;
      }

      const cfg = node?.config as { timeout?: WaitTimeoutConfig } | undefined;
      const timeoutTarget = cfg?.timeout?.timeout_node_key ?? null;

      if (!timeoutTarget) {
        // Stale deadline (node lost its timeout or changed type) — clear it.
        await db
          .update(flowRuns)
          .set({ timeoutAt: null })
          .where(eq(flowRuns.id, run.id));
        continue;
      }

      // Atomic claim: only fire while the run is STILL parked at this node.
      // If a reply advanced current_node_key first, the CAS matches nothing.
      const claimed = await db
        .update(flowRuns)
        .set({
          currentNodeKey: timeoutTarget,
          timeoutAt: null,
          lastAdvancedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(flowRuns.id, run.id),
            eq(flowRuns.status, "active"),
            eq(flowRuns.currentNodeKey, parkedKey),
          ),
        )
        .returning({ id: flowRuns.id });
      if (claimed.length === 0) continue;

      await logEvent(run.id, "timeout", parkedKey, {
        timeout_node_key: timeoutTarget,
      });
      await advanceFromNodeKey(
        { ...run, status: "active", current_node_key: timeoutTarget },
        timeoutTarget,
        nodes,
      );
      fired += 1;
    } catch (err) {
      console.error(
        "[flows] timeout advance failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { fired };
}

/**
 * One conversational turn of an `ai` node: generate a reply from the
 * account's AI agent (prompt + RAG, via generateFlowAiReply), send it as
 * a few short messages, then either loop (re-park, waiting for the next
 * customer message) or leave via `exit_node_key` (the AI handed off, hit
 * the turn cap, or couldn't answer). Called from the scheduler when the
 * message-buffer debounce fires.
 */
async function runAiTurn(
  run: FlowRunRow,
  node: FlowNodeRow,
  nodes: Map<string, FlowNodeRow>,
): Promise<void> {
  const cfg = node.config as unknown as AiNodeConfig;
  const exitTo = cfg.exit_node_key || null;
  const maxTurns =
    typeof cfg.max_turns === "number" && cfg.max_turns > 0
      ? cfg.max_turns
      : AI_DEFAULT_MAX_TURNS;
  const turns =
    (typeof run.vars.__ai_turns === "number" ? run.vars.__ai_turns : 0) + 1;

  // Persist the turn counter so it survives across debounce cycles.
  const newVars = { ...run.vars, __ai_turns: turns };
  try {
    await db
      .update(flowRuns)
      .set({ vars: newVars })
      .where(eq(flowRuns.id, run.id));
    run.vars = newVars;
  } catch {
    // Non-fatal.
  }

  const leave = async (reason: string, kind: "handoff" | "error") => {
    await logEvent(run.id, kind, node.node_key, { reason });
    if (exitTo && nodes.has(exitTo)) {
      await advanceFromNodeKey(run, exitTo, nodes);
    } else {
      await endRun(
        run.id,
        kind === "error" ? "failed" : "completed",
        reason,
      );
    }
  };

  if (!run.conversation_id || !run.contact_id) {
    await leave("ai_no_conversation", "error");
    return;
  }

  // Horário de atendimento da IA: a etapa só atende conforme o modo
  // (sempre / só dentro / só fora do horário da conta). Fora da janela
  // permitida, entrega pro caminho de saída (humano) em vez de responder.
  if (cfg.hours_mode && cfg.hours_mode !== "always") {
    const settings = await getAccountSettings(run.account_id);
    if (!aiHoursAllows(cfg.hours_mode, settings)) {
      await leave("ai_outside_configured_hours", "handoff");
      return;
    }
  }

  const result = await generateFlowAiReply({
    accountId: run.account_id,
    conversationId: run.conversation_id,
    nodePrompt: cfg.prompt,
    useKnowledge: cfg.use_knowledge !== false,
  });

  // No usable config / nothing to answer / provider error → human.
  if (!result.ok) {
    await leave(`ai_turn_failed:${result.reason ?? "erro"}`, "error");
    return;
  }
  // AI defers to a human, or produced nothing → exit path.
  if (result.handoff || !result.text.trim()) {
    await leave("ai_handoff", "handoff");
    return;
  }

  // Send the reply as a few short, human-sized messages. When typing is on
  // (default), show "digitando…" and pause a beat before each one so it
  // reads like a person, not a bot dumping text.
  const parts = splitIntoMessages(result.text);
  const typing = cfg.typing !== false;
  for (const part of parts) {
    try {
      if (typing) {
        await engineSendTyping({
          accountId: run.account_id,
          conversationId: run.conversation_id,
          contactId: run.contact_id,
          on: true,
        });
        await sleep(humanTypingDelayMs(part));
      }
      await engineSendText({
        accountId: run.account_id,
        userId: run.user_id,
        conversationId: run.conversation_id,
        contactId: run.contact_id,
        text: part,
      });
    } catch (err) {
      await logEvent(run.id, "error", node.node_key, {
        reason: "ai_send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (typing) {
    // Clear the indicator (a sent message already clears it, but be tidy).
    await engineSendTyping({
      accountId: run.account_id,
      conversationId: run.conversation_id,
      contactId: run.contact_id,
      on: false,
    });
  }
  await logEvent(run.id, "message_sent", node.node_key, {
    node_type: "ai",
    parts: parts.length,
    turn: turns,
  });

  // Anti-loop: too many AI turns → hand to a human.
  if (turns >= maxTurns) {
    await leave("ai_max_turns", "handoff");
    return;
  }

  // Keep chatting: re-park at the AI node with NO timer — the customer's
  // next message re-arms the debounce (handleReplyForActiveRun).
  await advanceCurrentNodeKey(run.id, run.current_node_key, node.node_key, null);
}

// ============================================================
// tag_added trigger — event-driven flow start (Fase 2, Etapa 2)
// ============================================================

/**
 * Resolve a conversation to send a tag-triggered flow on: the contact's
 * most-recent conversation, restricted to the flow's channel when it's bound.
 * Returns null when the contact has no conversation (nothing to message on).
 */
async function resolveContactConversation(
  accountId: string,
  contactId: string,
  channelId: string | null,
): Promise<string | null> {
  const conds = [
    eq(conversations.accountId, accountId),
    eq(conversations.contactId, contactId),
  ];
  if (channelId) conds.push(eq(conversations.channelId, channelId));
  const row = firstOrNull(
    await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(...conds))
      .orderBy(desc(conversations.updatedAt))
      .limit(1),
  );
  return row?.id ?? null;
}

/** Start a run for a contact from an EVENT (no inbound message). Mirrors
 *  startNewRun's insert/log/advance; the one-run-per-contact unique index
 *  (active+sleeping) makes a concurrent/duplicate start a safe no-op. */
async function startRunForContact(
  flow: FlowRow,
  contactId: string,
  conversationId: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<boolean> {
  let run: FlowRunRow;
  try {
    run = firstOrThrow(
      await db
        .insert(flowRuns)
        .values({
          flowId: flow.id,
          accountId: flow.account_id,
          userId: flow.user_id,
          contactId,
          conversationId,
          status: "active",
          currentNodeKey: flow.entry_node_id,
        })
        .returning(flowRunSelection),
    ) as unknown as FlowRunRow;
  } catch (insErr) {
    // 23505 → the contact already has a live run; don't stack another.
    if (isUniqueViolation(insErr)) return false;
    console.error(
      "[flows] startRunForContact insert error:",
      insErr instanceof Error ? insErr.message : insErr,
    );
    return false;
  }
  await logEvent(run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
  });
  try {
    await db.execute(sql`SELECT increment_flow_execution_count(${flow.id})`);
  } catch {
    // Non-fatal — the counter is cosmetic.
  }
  await advanceFromNodeKey(run, flow.entry_node_id!, nodes);
  return true;
}

/**
 * Fire tag_added flows for a contact. Called (best-effort) wherever a tag is
 * added to a contact — inbox/contacts UI, public API, automations, and the
 * set_tag node. Starts the first matching flow that has a conversation to
 * send on; the contact's one-live-run rule keeps this to a single flow.
 */
export async function dispatchTagAddedToFlows(
  accountId: string,
  contactId: string,
  tagId: string,
): Promise<void> {
  try {
    const all = (await db
      .select(flowSelection)
      .from(flowsTable)
      .where(
        and(
          eq(flowsTable.accountId, accountId),
          eq(flowsTable.status, "active"),
        ),
      )) as unknown as FlowRow[];
    const matches = all.filter(
      (f) =>
        f.trigger_type === "tag_added" &&
        f.entry_node_id &&
        (f.trigger_config as { tag_id?: string })?.tag_id === tagId,
    );
    if (matches.length === 0) return;

    for (const flow of matches) {
      const conversationId = await resolveContactConversation(
        accountId,
        contactId,
        flow.channel_id,
      );
      // No conversation → can't send WhatsApp; try the next matching flow.
      if (!conversationId) continue;
      const nodes = await loadAllNodes(flow.id);
      await startRunForContact(flow, contactId, conversationId, nodes);
      // The contact can only hold one live run, so stop after the first
      // flow that had a conversation to start on.
      break;
    }
  } catch (err) {
    console.error(
      "[flows] dispatchTagAddedToFlows error:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Inicia um fluxo ATIVO pra um contato a partir de um evento externo (ex.: a
 * automação de comentário do Instagram, depois de mandar o DM). Carrega o fluxo
 * (tem que ser da conta + `active` + com nó de entrada), resolve os nós e começa
 * a run. A trava de 1-run-por-contato torna um start duplicado um no-op seguro.
 * Best-effort: devolve false (sem lançar) se o fluxo não existe/não está ativo.
 */
export async function startFlowRunFromEvent(
  flowId: string,
  accountId: string,
  contactId: string,
  conversationId: string,
): Promise<boolean> {
  try {
    const flow = firstOrNull(
      await db
        .select(flowSelection)
        .from(flowsTable)
        .where(
          and(
            eq(flowsTable.id, flowId),
            eq(flowsTable.accountId, accountId),
            eq(flowsTable.status, "active"),
          ),
        )
        .limit(1),
    ) as unknown as FlowRow | null;
    if (!flow || !flow.entry_node_id) return false;
    const nodes = await loadAllNodes(flow.id);
    return await startRunForContact(flow, contactId, conversationId, nodes);
  } catch (err) {
    console.error(
      "[flows] startFlowRunFromEvent error:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Carrega um fluxo ATIVO + o nó de ENTRADA (pra automação de comentário do IG
 * mandar a 1ª mensagem — as opções — como resposta ao comentário, com botões de
 * resposta rápida). null se o fluxo não existe/não está ativo/sem entrada.
 */
export async function getCommentFlowStart(
  flowId: string,
  accountId: string,
): Promise<{ flow: FlowRow; entryNode: FlowNodeRow } | null> {
  const flow = firstOrNull(
    await db
      .select(flowSelection)
      .from(flowsTable)
      .where(
        and(
          eq(flowsTable.id, flowId),
          eq(flowsTable.accountId, accountId),
          eq(flowsTable.status, "active"),
        ),
      )
      .limit(1),
  ) as unknown as FlowRow | null;
  if (!flow || !flow.entry_node_id) return null;
  const nodes = await loadAllNodes(flow.id);
  const entryNode = nodes.get(flow.entry_node_id);
  if (!entryNode) return null;
  return { flow, entryNode };
}

/**
 * Cria uma run PARADA no nó de entrada (status active, current = entrada) SEM
 * enviar nada — a 1ª mensagem já foi mandada como resposta ao comentário (com
 * quick replies). Quando a pessoa TOCA num botão, o inbound casa o reply_id e o
 * motor avança daqui (com a janela de 24h já aberta pelo toque). A trava de
 * 1-run-por-contato faz um start duplicado virar no-op seguro.
 */
export async function startSuspendedRun(
  flow: FlowRow,
  contactId: string,
  conversationId: string,
): Promise<boolean> {
  try {
    const run = firstOrThrow(
      await db
        .insert(flowRuns)
        .values({
          flowId: flow.id,
          accountId: flow.account_id,
          userId: flow.user_id,
          contactId,
          conversationId,
          status: "active",
          currentNodeKey: flow.entry_node_id,
        })
        .returning(flowRunSelection),
    ) as unknown as FlowRunRow;
    await logEvent(run.id, "started", flow.entry_node_id, {
      flow_id: flow.id,
      trigger_type: flow.trigger_type,
      via: "instagram_comment",
    });
    try {
      await db.execute(sql`SELECT increment_flow_execution_count(${flow.id})`);
    } catch {
      // contador é cosmético
    }
    return true;
  } catch (insErr) {
    if (isUniqueViolation(insErr)) return false;
    console.error(
      "[flows] startSuspendedRun error:",
      insErr instanceof Error ? insErr.message : insErr,
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

    // Mid-drip: the contact has a run SLEEPING between delayed steps. An
    // inbound isn't a reply to a timer, and we mustn't start a second flow on
    // top of the drip. Leave the message to AI/human (consumed:false) — the
    // drip keeps advancing on its own schedule via the scheduler worker.
    if (activeRun && activeRun.status === "sleeping") {
      return {
        consumed: false,
        flow_run_id: activeRun.id,
        outcome: "no_match",
      };
    }

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
    // Resolve the conversation's channel (channel-bound flows only fire on
    // their channel) AND status. Null channel (legacy conv) → only unbound
    // "todos os canais" flows match.
    const conv = firstOrNull(
      await db
        .select({
          channelId: conversations.channelId,
          status: conversations.status,
        })
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .limit(1),
    );

    // Don't (re)START a flow when a human already owns the conversation. After
    // a handoff (or an exhausted/timed-out fallback) the status is 'pending'
    // and an attendant is handling it — the bot resending its menu would
    // steamroll them. A flow should only auto-start on an OPEN conversation.
    // Active runs are handled ABOVE this point, so an in-progress flow is never
    // affected — this only blocks brand-new auto-starts.
    if (conv?.status === "pending") {
      return { consumed: false, outcome: "suppressed_human_owned" };
    }

    const flow = await findEntryFlow(
      input.accountId,
      input.message,
      input.isFirstInboundMessage,
      conv?.channelId ?? null,
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

  // AI node: the customer is chatting with the agent. Don't match a
  // reply_id — just (re)arm the debounce so a burst of messages collapses
  // into one reply once they go quiet. The message is already persisted,
  // so the scheduler's AI turn will read it from the conversation history.
  if (currentNode.node_type === "ai") {
    const cfg = currentNode.config as unknown as AiNodeConfig;
    try {
      await db
        .update(flowRuns)
        .set({ timeoutAt: aiDebounceAtIso(cfg) })
        .where(eq(flowRuns.id, run.id));
    } catch {
      // Non-fatal — the existing deadline still fires eventually.
    }
    return { consumed: true, flow_run_id: run.id, outcome: "advanced" };
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
    // The customer replied → cancel this node's no-reply timeout so the
    // scheduler can't also fire it. A downstream re-suspend re-arms a
    // fresh one; the terminal case (no re-suspend) just leaves it clear.
    try {
      await db
        .update(flowRuns)
        .set({ timeoutAt: null })
        .where(eq(flowRuns.id, run.id));
    } catch {
      // Non-fatal — a stale deadline on a run that advances past its
      // node is harmless (the scheduler's claim CAS on current_node_key
      // fails once the node moves).
    }
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
