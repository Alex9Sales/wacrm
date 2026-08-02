/**
 * Type definitions for the Flows runtime.
 *
 * These mirror the DB schema added in migration 010 (`flows`,
 * `flow_nodes`, `flow_runs`, `flow_run_events`) plus the discriminated
 * unions the engine uses to typecheck node configs.
 *
 * Schema invariants enforced here that the DB CHECK constraints don't:
 *   - Each node_type maps to one config shape — adding a new node_type
 *     requires adding the matching config interface AND extending
 *     `FlowNodeConfig` so the engine's exhaustiveness checks light up.
 *   - Edges live INSIDE the config (each button row / list row carries
 *     `next_node_key`). The DB schema doesn't model this — the
 *     validator (PR #3) catches missing or orphan edges at save time.
 *
 * `next_node_key` is the stable string id stored in `flow_nodes.node_key`,
 * not a UUID, so flows can be cloned / templated without rewriting
 * references in JSONB.
 */

// ============================================================
// Node configs (discriminated union by node_type)
// ============================================================

export interface StartNodeConfig {
  /** Stable node_key of the first real node to advance to. */
  next_node_key: string;
}

export interface SendMessageNodeConfig {
  /** Plain text sent to the customer; can interpolate {{vars.X}}. */
  text: string;
  /** Auto-advance target after the message lands at Meta. */
  next_node_key: string;
}

/**
 * Optional "no-reply timeout" on a node that suspends awaiting the
 * customer (send_buttons / send_list / collect_input). When set, the run
 * parks with a deadline; if no reply lands before it, the flows scheduler
 * routes the run down `timeout_node_key` instead of leaving it stuck
 * forever. This is the "se o cliente sumir, faz X" path (a follow-up
 * nudge, a handoff, or ending the flow).
 */
export interface WaitTimeoutConfig {
  duration: {
    value: number;
    unit: "minutes" | "hours" | "days";
  };
  /** node_key to advance to when the reply window elapses. */
  timeout_node_key: string;
}

export interface SendButtonsNodeConfig {
  text: string;
  /** Optional header / footer lines around the buttons. */
  header_text?: string;
  footer_text?: string;
  /** 1-3 buttons; Meta cap enforced in meta-api validation. */
  buttons: Array<{
    /** Stable id sent back by Meta when this button is tapped. */
    reply_id: string;
    /** Visible label (≤ 20 chars per Meta). */
    title: string;
    /** node_key the runner advances to when this button is tapped. */
    next_node_key: string;
  }>;
  /** Optional no-reply timeout path. */
  timeout?: WaitTimeoutConfig;
}

export interface SendListNodeConfig {
  text: string;
  /** Label of the tap-to-expand button on the message bubble. */
  button_label: string;
  header_text?: string;
  footer_text?: string;
  /** 1-10 rows TOTAL across sections; cap enforced in meta-api. */
  sections: Array<{
    title?: string;
    rows: Array<{
      reply_id: string;
      title: string;
      description?: string;
      next_node_key: string;
    }>;
  }>;
  /** Optional no-reply timeout path. */
  timeout?: WaitTimeoutConfig;
}

/**
 * Sends a single image / video / document via WhatsApp, then
 * auto-advances. The media file is uploaded to the `flow-media`
 * Supabase Storage bucket by the builder; `media_url` is the public
 * URL Meta fetches at send time.
 *
 * Why one node with a `media_type` discriminator (rather than three
 * separate node types): Meta's send-side payload differs only in the
 * top-level key (`image` / `video` / `document`) and the
 * filename-on-document quirk. Modeling three node types would triple
 * the builder forms, engine cases, and add-menu entries for no
 * meaningful behavioural difference.
 */
export interface SendMediaNodeConfig {
  media_type: "image" | "video" | "document";
  /** Public URL Meta will fetch. Uploaded via the builder's file picker. */
  media_url: string;
  /** Optional caption shown under the media (Meta caps at 1024 chars). */
  caption?: string;
  /**
   * Filename shown in the recipient's chat. Documents only — Meta
   * ignores it for image/video. Defaults to the file's original name
   * at upload time; the user can edit it.
   */
  filename?: string;
  /** Auto-advance target after the send lands at Meta. */
  next_node_key: string;
}

export interface HandoffNodeConfig {
  /** Optional message SENT TO THE CUSTOMER when handing off, so they get a
   *  reply instead of silence after picking an option. */
  customer_message?: string;
  /** Optional internal note — posted as an internal note in the conversation
   *  (visible to the team, never to the customer). */
  note?: string;
  /**
   * Optional agent user_id to assign on the conversation when this
   * node fires. Leave unset to flip the status without assignment.
   */
  assign_to?: string;
}

/**
 * Captures the customer's next free-text reply into
 * `flow_runs.vars[var_key]`, then advances.
 *
 * v1.5 ships without runtime validation (`validation` is accepted on
 * the config for forward compat but ignored by the runner); the
 * builder still surfaces the field so users can author flows that
 * v2 will start enforcing.
 */
export interface CollectInputNodeConfig {
  /** Prompt text sent to the customer before they reply. */
  prompt_text: string;
  /**
   * Key under which to store the captured text in
   * `flow_runs.vars`. Stable identifier — used by downstream
   * `condition` nodes and `handoff` notes via interpolation.
   */
  var_key: string;
  /**
   * Reserved for v2. Accepted on the config but ignored by the v1.5
   * runner — captures any non-empty text.
   */
  validation?: "any" | "email" | "phone" | "regex";
  /** Used only when `validation === 'regex'`. */
  regex?: string;
  /** Node to advance to after capture. */
  next_node_key: string;
  /** Optional no-reply timeout path. */
  timeout?: WaitTimeoutConfig;
}

export type ConditionOperator =
  | "equals"
  | "contains"
  | "present"
  | "absent";

export type ConditionSubject = "var" | "tag" | "contact_field";

/**
 * Routes the run based on a predicate over the contact's tags,
 * profile fields, or stored vars. Always auto-advances — no Meta
 * call, no customer-side input.
 */
export interface ConditionNodeConfig {
  subject: ConditionSubject;
  /**
   * For `var`: the key in flow_runs.vars.
   * For `tag`: the tag UUID (matched against contact_tags).
   * For `contact_field`: one of 'name' | 'email' | 'phone' | 'company'.
   */
  subject_key: string;
  operator: ConditionOperator;
  /** Compared against `subject` for `equals`/`contains`. Ignored for `present`/`absent`. */
  value?: string;
  /** Node to advance to when the predicate evaluates true. */
  true_next: string;
  /** Node to advance to when it evaluates false. */
  false_next: string;
}

export interface SetTagNodeConfig {
  mode: "add" | "remove";
  /** Tag UUID. The builder picks from the user's existing tags. */
  tag_id: string;
  next_node_key: string;
}

/**
 * Pauses the run for a fixed duration, then auto-advances. The run is
 * PERSISTED as sleeping (flow_runs.status='sleeping' + resume_at) and a
 * background worker wakes it when due — so a delay of days survives
 * restarts. This is the backbone of drip/nurture flows.
 */
export interface DelayNodeConfig {
  duration: {
    value: number;
    unit: "minutes" | "hours" | "days";
  };
  /** Node to advance to once the delay elapses. */
  next_node_key: string;
  /**
   * Optional "smart delay" (ManyChat's Atraso Inteligente): after the
   * duration elapses, hold the resume until it lands inside a daily
   * business-hours window. E.g. a delay that would wake at 3am rolls
   * forward to the next window opening — so drip messages never arrive
   * in the middle of the night. Omit for a plain wall-clock delay.
   */
  business_hours?: {
    /** IANA timezone, e.g. "America/Sao_Paulo". */
    timezone: string;
    /** Window open, "HH:MM" 24h (local to `timezone`). */
    start: string;
    /** Window close, "HH:MM" 24h (local to `timezone`). */
    end: string;
    /** Allowed weekdays: 0=Sun … 6=Sat. Empty = never (treated as off). */
    days: number[];
  };
}

/**
 * Jumps the run to another node — used for loops (e.g. "wait 30 days →
 * jump back to the entry check"). Anti-loop: the engine caps total jumps per
 * run (MAX_JUMPS_PER_RUN) and fails the run past that, so a drip cycle can't
 * spin forever.
 */
export interface JumpNodeConfig {
  /** node_key to continue the run from. */
  target_node_key: string;
}

/**
 * Splits the run randomly across N weighted branches (ManyChat's
 * "Randomizador"). Great for A/B testing messages. Weights are relative —
 * the engine normalizes them, so they don't have to sum to 100.
 */
export interface RandomizerNodeConfig {
  branches: Array<{
    /** Stable id (for the canvas edge handle). */
    id: string;
    /** Relative weight; the engine picks proportionally. */
    weight: number;
    /** node_key this branch advances to. */
    next_node_key: string;
  }>;
}

/**
 * Calls an external HTTP API mid-flow, stores the response in the run's
 * vars, then auto-advances. URL / headers / body support `{{vars.x}}`
 * interpolation. The engine fetches through an SSRF guard (public https
 * only; private / loopback / cloud-metadata hosts are refused), a
 * timeout, and a response-size cap. On a network error / non-2xx /
 * refused target it routes to `error_node_key` when set, else falls
 * through to `next_node_key` (the flow continues; the error is logged +
 * stored in `<save_to>_error`).
 */
export interface HttpFetchNodeConfig {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Public https (or http) URL. Interpolated. */
  url: string;
  /** Optional request headers. Values interpolated. */
  headers?: Array<{ key: string; value: string }>;
  /** Optional request body (raw string, interpolated). Ignored for GET. */
  body?: string;
  /**
   * Var-key prefix for the stored response. Defaults to "http". Writes
   * `<save_to>` (body text), `<save_to>_status` (HTTP status), and, on
   * failure, `<save_to>_error`.
   */
  save_to?: string;
  /** Node to advance to on success (2xx). */
  next_node_key: string;
  /** Optional node to advance to on failure. Falls back to next_node_key. */
  error_node_key?: string;
}

// Terminal nodes carry no config — they just stop the run.
export type EndNodeConfig = Record<string, never>;

/**
 * Total union — every concrete node_type the v1 engine understands.
 * Add new node types here and the engine's switch will flag missing
 * cases via TypeScript's exhaustiveness check.
 *
 * v1.5+ additions (collect_input, condition, set_tag, http_fetch) will
 * extend this union — out-of-scope for the v1 engine PR.
 */
export type FlowNodeConfig =
  | { node_type: "start"; config: StartNodeConfig }
  | { node_type: "send_message"; config: SendMessageNodeConfig }
  | { node_type: "send_buttons"; config: SendButtonsNodeConfig }
  | { node_type: "send_list"; config: SendListNodeConfig }
  | { node_type: "send_media"; config: SendMediaNodeConfig }
  | { node_type: "collect_input"; config: CollectInputNodeConfig }
  | { node_type: "condition"; config: ConditionNodeConfig }
  | { node_type: "set_tag"; config: SetTagNodeConfig }
  | { node_type: "delay"; config: DelayNodeConfig }
  | { node_type: "jump"; config: JumpNodeConfig }
  | { node_type: "randomizer"; config: RandomizerNodeConfig }
  | { node_type: "http_fetch"; config: HttpFetchNodeConfig }
  | { node_type: "handoff"; config: HandoffNodeConfig }
  | { node_type: "end"; config: EndNodeConfig };

export type FlowNodeType = FlowNodeConfig["node_type"];

// ============================================================
// Triggers (matches `flows.trigger_type` + `trigger_config`)
// ============================================================

export interface KeywordTriggerConfig {
  /** One or more keywords. Match is case-insensitive by default. */
  keywords: string[];
  match_type?: "exact" | "contains";
  case_sensitive?: boolean;
}

// No knobs in v1 — the trigger has a single semantic. Kept as a type
// alias (not an empty interface) for forward compat without tripping
// the no-empty-object-type lint rule.
export type FirstInboundTriggerConfig = Record<string, never>;

/**
 * Fires when a specific tag is ADDED to a contact (via the inbox/contacts UI,
 * the public API, an automation, or a flow's set_tag node). Event trigger —
 * not tied to an inbound message. The flow runs on the contact's most-recent
 * conversation (respecting the flow's channel binding when set).
 */
export interface TagAddedTriggerConfig {
  /** The tag UUID whose addition starts this flow. */
  tag_id: string;
}

export type FlowTriggerConfig =
  | { trigger_type: "keyword"; config: KeywordTriggerConfig }
  | { trigger_type: "first_inbound_message"; config: FirstInboundTriggerConfig }
  | { trigger_type: "tag_added"; config: TagAddedTriggerConfig }
  | { trigger_type: "manual"; config: Record<string, never> };

// ============================================================
// DB-row shapes (read by the engine via the shared Drizzle client)
// ============================================================

export interface FlowRow {
  id: string;
  /** Account tenancy (NOT NULL post-017). The engine looks up active
   *  flows for inbound dispatch using this field. */
  account_id: string;
  /** Author. Used as a default sender-of-record on engine sends and
   *  preserved on flow_runs for log/audit display. */
  user_id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  trigger_type: "keyword" | "first_inbound_message" | "tag_added" | "manual";
  trigger_config: KeywordTriggerConfig | FirstInboundTriggerConfig | Record<string, unknown>;
  entry_node_id: string | null;
  /** Optional channel binding. null = todos os canais da conta (legado);
   *  quando setado, o fluxo só dispara em inbounds desse canal. */
  channel_id: string | null;
  fallback_policy: FlowFallbackPolicy;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowNodeRow {
  id: string;
  flow_id: string;
  node_key: string;
  node_type: FlowNodeType;
  config: Record<string, unknown>;
  position_x: number;
  position_y: number;
  created_at: string;
}

export interface FlowRunRow {
  id: string;
  flow_id: string;
  /** Tenancy. Matches flows.account_id; NOT NULL post-017. */
  account_id: string;
  /** Audit. Matches the parent flow.user_id. */
  user_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  status:
    | "active"
    | "sleeping"
    | "completed"
    | "handed_off"
    | "timed_out"
    | "paused_by_agent"
    | "failed";
  current_node_key: string | null;
  last_prompt_message_id: string | null;
  vars: Record<string, unknown>;
  reprompt_count: number;
  started_at: string;
  last_advanced_at: string;
  ended_at: string | null;
  end_reason: string | null;
}

// ============================================================
// Fallback policy (matches flows.fallback_policy JSONB)
// ============================================================

export interface FlowFallbackPolicy {
  /** What to do when the customer reply doesn't match any option. */
  on_unknown_reply: "reprompt" | "handoff" | "ignore";
  /** Max reprompts before applying `on_exhaust`. */
  max_reprompts: number;
  /** Stale-run sweep cutoff. */
  on_timeout_hours: number;
  /** What to do once max_reprompts has been hit. */
  on_exhaust: "handoff" | "end";
}

export const DEFAULT_FALLBACK_POLICY: FlowFallbackPolicy = {
  on_unknown_reply: "reprompt",
  max_reprompts: 2,
  on_timeout_hours: 24,
  on_exhaust: "handoff",
};

/** Minimal channel shape the builder's "Canal" picker needs. Served by
 *  GET /api/flows/[id] alongside the flow (account-scoped, SAFE fields). */
export interface FlowChannelOption {
  id: string;
  name: string;
  provider: string;
  phone_number: string | null;
}

/** Minimal member shape the handoff node's "Atribuir a" picker needs.
 *  Served by GET /api/flows/[id] alongside the flow. */
export interface FlowMemberOption {
  user_id: string;
  full_name: string;
  avatar_url: string | null;
}

/** Minimal tag shape the tag_added trigger + set_tag node pickers need. */
export interface FlowTagOption {
  id: string;
  name: string;
  color: string | null;
}

// ============================================================
// Engine input — what `dispatchInboundToFlows` accepts
// ============================================================

/**
 * Normalised view of an inbound message that the runner needs. The
 * webhook lifts this out of the raw Meta payload before invoking the
 * runner; keeps the runner free of any WhatsApp-API specifics.
 */
export type ParsedInbound =
  | {
      kind: "text";
      /** The user's typed message body. */
      text: string;
      /** Meta's `messages[0].id` — used for idempotency. */
      meta_message_id: string;
    }
  | {
      kind: "interactive_reply";
      /** The reply_id of the tapped button or list row. */
      reply_id: string;
      /** The visible title of the tapped option (for logging). */
      reply_title: string;
      meta_message_id: string;
    };

export interface DispatchInboundInput {
  /** Account tenancy key. Drives the lookup of active flows and the
   *  idempotency check for previously-seen inbound message_ids. */
  accountId: string;
  /** Sender-of-record for the bot's outbound prompts on engine
   *  sends. Set by the webhook to the WhatsApp config owner. */
  userId: string;
  contactId: string;
  conversationId: string;
  message: ParsedInbound;
}

export interface DispatchInboundResult {
  /**
   * True iff the runner handled the message — it either advanced an
   * existing run or started a new one matching a flow trigger.
   * Webhook uses this to decide whether to also fire automations.
   */
  consumed: boolean;
  /** For diagnostics / logging — null when not consumed. */
  flow_run_id?: string;
  /** For diagnostics. */
  outcome?:
    | "advanced"
    | "started"
    | "completed"
    | "handed_off"
    | "fallback_fired"
    | "duplicate_inbound_ignored"
    | "suppressed_human_owned"
    | "sleeping"
    | "no_match";
}

// ============================================================
// Helpers — exhaustiveness assertions
// ============================================================

/**
 * Throws a typed compile-time error if the switch over a discriminated
 * union forgets a case. Used in the engine's node-type switch.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled node type: ${JSON.stringify(x)}`);
}
