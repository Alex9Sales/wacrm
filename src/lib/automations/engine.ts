import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  SendMessageStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  AssignConversationStepConfig,
} from '@/types'
import {
  db,
  organization,
  automations as automationsTable,
  automationLogs,
  automationPendingExecutions,
  automationSteps,
  contactCustomValues,
  contactTags,
  contacts,
  conversations,
  customFields,
  deals,
  member,
} from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { and, asc, count, eq, gte, isNull, sql } from 'drizzle-orm'
import { engineSendText, engineSendTemplate } from './meta-send'

// ------------------------------------------------------------
// Row mappings — the engine's public types (src/types) are
// snake_case, so selects rename Drizzle's camelCase properties
// back to the wire shape the rest of the file expects.
// ------------------------------------------------------------

const automationSelection = {
  id: automationsTable.id,
  account_id: automationsTable.accountId,
  user_id: automationsTable.userId,
  name: automationsTable.name,
  description: automationsTable.description,
  trigger_type: automationsTable.triggerType,
  trigger_config: automationsTable.triggerConfig,
  is_active: automationsTable.isActive,
  execution_count: automationsTable.executionCount,
  last_executed_at: automationsTable.lastExecutedAt,
  created_at: automationsTable.createdAt,
  updated_at: automationsTable.updatedAt,
}

const stepSelection = {
  id: automationSteps.id,
  automation_id: automationSteps.automationId,
  parent_step_id: automationSteps.parentStepId,
  branch: automationSteps.branch,
  step_type: automationSteps.stepType,
  step_config: automationSteps.stepConfig,
  position: automationSteps.position,
  created_at: automationSteps.createdAt,
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string
  /** Conversation the event belongs to, if any. */
  conversation_id?: string
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>
  /** The tag id that was added, for tag_added trigger. */
  tag_id?: string
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string
}

export interface DispatchInput {
  /** Account-level tenancy key. Drives the lookup of which active
   *  automations to fire — `automations.account_id` is the tenant
   *  isolation after migration 017. Replaces the previous `userId`
   *  field; the per-automation user_id is read off each row when
   *  needed (sender identity for outbound messages, log audit). */
  accountId: string
  triggerType: AutomationTriggerType
  contactId?: string | null
  context?: AutomationContext
}

/**
 * Fire all active automations matching the given trigger for an
 * account.
 *
 * Must never throw — callers use fire-and-forget from the webhook.
 * All errors are caught and logged; per-automation failures are
 * recorded into automation_logs with status='failed'.
 */
export async function runAutomationsForTrigger(input: DispatchInput): Promise<void> {
  try {
    // Tenant isolation. `contactId` can be caller-supplied (the manual
    // POST /api/automations/engine entrypoint reads it straight from the
    // request body), and every step below runs through the shared
    // Drizzle client, which has no RLS. So before any step can touch the
    // contact, verify it actually belongs to this account. A foreign or
    // forged id is refused silently — callers are fire-and-forget, and a
    // distinct error would leak whether a given contact UUID exists.
    if (input.contactId) {
      const owned = firstOrNull(
        await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.id, input.contactId),
              eq(contacts.accountId, input.accountId),
            ),
          )
          .limit(1),
      )
      if (!owned) {
        console.warn('[automations] contact not in account, refusing dispatch', input.contactId)
        return
      }
    }

    const automations = (await db
      .select(automationSelection)
      .from(automationsTable)
      .where(
        and(
          eq(automationsTable.accountId, input.accountId),
          eq(automationsTable.triggerType, input.triggerType),
          eq(automationsTable.isActive, true),
        ),
      )) as unknown as Automation[]

    if (!automations || automations.length === 0) return

    for (const automation of automations) {
      if (!triggerMatches(automation, input.context)) continue
      try {
        await executeAutomation(automation, input)
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err)
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err)
  }
}

/**
 * Resume a run that was parked at a wait step. Called from the cron
 * endpoint after it grabs a due `automation_pending_executions` row.
 */
export async function resumePendingExecution(pending: {
  id: string
  automation_id: string
  /** Audit-only; the automation row carries account_id for tenancy. */
  user_id: string
  /** Account-scoped lookups read from the automation row, so this
   *  field is just here to mirror the row shape and keep the cron's
   *  pass-through self-documenting. */
  account_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  context: AutomationContext
}): Promise<void> {
  let automation: Automation | null = null
  try {
    automation = firstOrNull(
      await db
        .select(automationSelection)
        .from(automationsTable)
        .where(eq(automationsTable.id, pending.automation_id))
        .limit(1),
    ) as unknown as Automation | null
  } catch (err) {
    console.error('[automations] resume: missing automation', pending.automation_id, err)
    await markPending(pending.id, 'failed')
    return
  }

  if (!automation) {
    console.error('[automations] resume: missing automation', pending.automation_id, null)
    await markPending(pending.id, 'failed')
    return
  }

  try {
    await executeStepsFrom({
      automation,
      contactId: pending.contact_id,
      context: pending.context ?? {},
      parentStepId: pending.parent_step_id,
      branch: pending.branch,
      startPosition: pending.next_step_position,
      logId: pending.log_id,
      triggerEvent: 'resumed_wait',
    })
    await markPending(pending.id, 'done')
  } catch (err) {
    console.error('[automations] resume failed:', err)
    await markPending(pending.id, 'failed')
  }
}

// ------------------------------------------------------------
// Internal execution
// ------------------------------------------------------------

async function executeAutomation(automation: Automation, input: DispatchInput) {
  let log: { id: string } | null = null
  try {
    log = firstOrThrow(
      await db
        .insert(automationLogs)
        .values({
          automationId: automation.id,
          // Tenancy: matches automation.account_id (NOT NULL post-017).
          accountId: automation.account_id,
          // Audit: keeps the historical "author of this automation"
          // pointer so logs still attribute to the right user even
          // after teammates join the account.
          userId: automation.user_id,
          contactId: input.contactId ?? null,
          triggerEvent: input.triggerType,
          stepsExecuted: [],
          status: 'success',
        })
        .returning({ id: automationLogs.id }),
    )
  } catch (logErr) {
    console.error('[automations] cannot create log:', logErr)
    return
  }

  await executeStepsFrom({
    automation,
    contactId: input.contactId ?? null,
    context: input.context ?? {},
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.id,
    triggerEvent: input.triggerType,
  })

  // Atomic counter update via the SQL function from migration 007.
  // Doing this with a client-side read-modify-write raced when the
  // same automation fired for two contacts simultaneously — both
  // would read N and both write N+1, losing one count permanently.
  try {
    await db.execute(sql`SELECT increment_automation_execution_count(${automation.id})`)
  } catch (rpcErr) {
    console.error('[automations] increment counter failed:', rpcErr)
  }
}

interface ExecuteArgs {
  automation: Automation
  contactId: string | null
  context: AutomationContext
  parentStepId: string | null
  branch: 'yes' | 'no' | null
  startPosition: number
  logId: string | null
  triggerEvent: string
}

async function executeStepsFrom(args: ExecuteArgs): Promise<void> {
  let steps: AutomationStep[]
  try {
    const scopeCondition =
      args.parentStepId === null
        ? isNull(automationSteps.parentStepId)
        : and(
            eq(automationSteps.parentStepId, args.parentStepId),
            eq(automationSteps.branch, args.branch ?? 'yes'),
          )

    steps = (await db
      .select(stepSelection)
      .from(automationSteps)
      .where(
        and(
          eq(automationSteps.automationId, args.automation.id),
          gte(automationSteps.position, args.startPosition),
          scopeCondition,
        ),
      )
      .orderBy(asc(automationSteps.position))) as unknown as AutomationStep[]
  } catch (stepsErr) {
    const msg = stepsErr instanceof Error ? stepsErr.message : String(stepsErr)
    await finalizeLog(args.logId, 'failed', msg)
    return
  }

  if (!steps || steps.length === 0) {
    if (args.parentStepId === null && args.logId) {
      await finalizeLog(args.logId, 'success', null)
    }
    return
  }

  const results: AutomationLogStepResult[] = []
  let status: 'success' | 'partial' | 'failed' = 'success'
  let errorMessage: string | null = null

  for (const step of steps) {
    // `wait` is the suspension point: enqueue and stop processing this
    // scope. The cron endpoint will pick it up later.
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig
      const ms = waitMs(cfg)
      await db.insert(automationPendingExecutions).values({
        automationId: args.automation.id,
        // Tenancy: account_id required NOT NULL post-017.
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        contactId: args.contactId,
        logId: args.logId,
        parentStepId: args.parentStepId,
        branch: args.branch,
        nextStepPosition: step.position + 1,
        context: args.context,
        runAt: new Date(Date.now() + ms).toISOString(),
        status: 'pending',
      })
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      })
      status = 'partial'
      await appendResults(args.logId, results, status, errorMessage)
      return
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig
        const taken = await evaluateCondition(cfg, args)
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        })
        // Recurse into the chosen branch at position 0 (children use their
        // own ordering within the branch scope).
        await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
        })
        continue
      }

      const detail = await runStep(step, args)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      })
      status = 'failed'
      errorMessage = msg
      break
    }
  }

  if (args.parentStepId === null) {
    await appendResults(args.logId, results, status, errorMessage)
  } else {
    // Nested branch — just append results; parent scope decides final status.
    await appendResults(args.logId, results, null, errorMessage)
  }
}

async function runStep(step: AutomationStep, args: ExecuteArgs): Promise<string> {
  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig
      if (!args.contactId) throw new Error('send_message needs a contact')
      const text = interpolate(cfg.text, args)
      if (!text.trim()) throw new Error('send_message has empty text')
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      })
      return `sent via Meta (${whatsapp_message_id})`
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig
      if (!args.contactId) throw new Error('send_template needs a contact')
      if (!cfg.template_name) throw new Error('send_template needs template_name')
      const conversationId = await resolveConversationId(args)
      // Meta templates use positional {{1}}, {{2}}, … placeholders, so
      // we MUST emit params in strict numeric order. Lexicographic sort
      // of "1", "2", …, "10" yields "1", "10", "2", … which silently
      // scrambles every template with ≥10 variables.
      const params = cfg.variables
        ? Object.keys(cfg.variables)
            .sort((a, b) => {
              const na = Number(a)
              const nb = Number(b)
              const aNum = Number.isFinite(na)
              const bNum = Number.isFinite(nb)
              if (aNum && bNum) return na - nb
              if (aNum) return -1
              if (bNum) return 1
              return a.localeCompare(b)
            })
            .map((k) => String(cfg.variables![k]))
        : []
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
      })
      return `template sent via Meta (${whatsapp_message_id})`
    }

    case 'add_tag': {
      // contact_tags has no account_id column; cross-tenant protection for
      // the attacker-supplied contactId comes from the ownership guard in
      // runAutomationsForTrigger.
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('add_tag needs contact + tag_id')
      await db
        .insert(contactTags)
        .values({ contactId: args.contactId, tagId: cfg.tag_id })
        .onConflictDoNothing({ target: [contactTags.contactId, contactTags.tagId] })
      return `tag ${cfg.tag_id} added`
    }

    case 'remove_tag': {
      // See add_tag: tenant scoping relies on the runAutomationsForTrigger
      // ownership guard, since contact_tags carries no account_id.
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('remove_tag needs contact + tag_id')
      await db
        .delete(contactTags)
        .where(
          and(
            eq(contactTags.contactId, args.contactId),
            eq(contactTags.tagId, cfg.tag_id),
          ),
        )
      return `tag ${cfg.tag_id} removed`
    }

    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig
      if (!args.contactId) throw new Error('assign_conversation needs a contact')
      let agentId = cfg.agent_id
      if (cfg.mode === 'round_robin') {
        // Pick any member of the account. The existing implementation
        // only ever returned the automation's author; preserving that
        // shape until a real round-robin algorithm replaces it.
        const pick = firstOrNull(
          await db
            .select({ user_id: member.userId })
            .from(member)
            .where(eq(member.organizationId, args.automation.account_id))
            .limit(1),
        )
        agentId = pick?.user_id
      }
      if (!agentId) return 'no agent resolved'
      await db
        .update(conversations)
        .set({ assignedAgentId: agentId })
        .where(
          and(
            eq(conversations.accountId, args.automation.account_id),
            eq(conversations.contactId, args.contactId),
          ),
        )
      return `assigned to ${agentId}`
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig
      if (!args.contactId) throw new Error('update_contact_field needs a contact')
      // Resolve workflow variables ({{ vars.* }}, {{ message.text }}) so custom
      // values can be populated dynamically from the triggering context.
      const value = interpolate(cfg.value, args)

      // Custom fields are encoded as `custom:<custom_field_id>`; anything else
      // is a built-in contact column.
      if (cfg.field.startsWith('custom:')) {
        const customFieldId = cfg.field.slice('custom:'.length)
        if (!customFieldId) {
          return `field ${cfg.field} not writable from automations`
        }
        // Defense in depth: the shared client has no RLS, so confirm
        // the field definition belongs to this account before writing.
        const field = firstOrNull(
          await db
            .select({ id: customFields.id })
            .from(customFields)
            .where(
              and(
                eq(customFields.id, customFieldId),
                eq(customFields.accountId, args.automation.account_id),
              ),
            )
            .limit(1),
        )
        if (!field) {
          return `field ${cfg.field} not writable from automations`
        }
        // Upsert on the table's UNIQUE(contact_id, custom_field_id) so repeated
        // runs overwrite rather than duplicate. Tenancy is enforced above and,
        // for the contact side, by the entry-point ownership guard.
        await db
          .insert(contactCustomValues)
          .values({ contactId: args.contactId, customFieldId, value })
          .onConflictDoUpdate({
            target: [contactCustomValues.contactId, contactCustomValues.customFieldId],
            set: { value },
          })
        return `custom field updated`
      }

      const allowed = new Set(['name', 'email', 'company'])
      if (!allowed.has(cfg.field)) {
        return `field ${cfg.field} not writable from automations`
      }
      // Defense in depth: scope the write to the account so a future
      // caller that skips the entry-point ownership guard still
      // cannot write across tenants.
      await db
        .update(contacts)
        .set({
          [cfg.field]: value,
          updatedAt: new Date().toISOString(),
        } as Partial<typeof contacts.$inferInsert>)
        .where(
          and(
            eq(contacts.id, args.contactId),
            eq(contacts.accountId, args.automation.account_id),
          ),
        )
      return `${cfg.field} updated`
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig
      if (!cfg.pipeline_id || !cfg.stage_id) throw new Error('create_deal needs pipeline + stage')
      // Match the account's configured default currency rather than
      // the static `deals.currency` DB default — keeps automation-
      // created deals consistent with the one-currency-per-account
      // rule (issue #218). Fall back to USD if the row is somehow
      // missing the value (pre-021 forks).
      const acct = firstOrNull(
        await db
          .select({ default_currency: organization.default_currency })
          .from(organization)
          .where(eq(organization.id, args.automation.account_id))
          .limit(1),
      )
      await db.insert(deals).values({
        // Tenancy + audit, same split as automation_logs above.
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        pipelineId: cfg.pipeline_id,
        stageId: cfg.stage_id,
        contactId: args.contactId,
        title: interpolate(cfg.title, args),
        value: String(cfg.value ?? 0),
        currency: acct?.default_currency ?? 'USD',
        status: 'open',
      })
      return 'deal created'
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig
      if (!cfg.url) throw new Error('send_webhook needs url')
      const body = cfg.body_template ? interpolate(cfg.body_template, args) : JSON.stringify(args.context)
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
      })
      if (!res.ok) throw new Error(`webhook returned ${res.status}`)
      return `webhook ${res.status}`
    }

    case 'close_conversation': {
      if (!args.contactId) throw new Error('close_conversation needs a contact')
      await db
        .update(conversations)
        .set({ status: 'closed', updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(conversations.accountId, args.automation.account_id),
            eq(conversations.contactId, args.contactId),
          ),
        )
      return 'conversation closed'
    }

    default:
      return `unknown step: ${step.step_type}`
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Pick the conversation a send-type step should use. Prefer the id the
 * webhook handed us (it's the one that just got the inbound message);
 * fall back to the contact's conversation for resumed/wait paths and
 * manual engine POSTs. Throws if none exists — send steps have
 * no meaningful target without a conversation.
 */
async function resolveConversationId(args: ExecuteArgs): Promise<string> {
  const fromCtx = args.context.conversation_id
  if (fromCtx) return fromCtx
  if (!args.contactId) throw new Error('cannot resolve conversation: no contact')
  const row = firstOrNull(
    await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.accountId, args.automation.account_id),
          eq(conversations.contactId, args.contactId),
        ),
      )
      .limit(1),
  )
  if (!row?.id) throw new Error('no conversation for contact')
  return row.id
}

function triggerMatches(automation: Automation, ctx: AutomationContext | undefined): boolean {
  if (automation.trigger_type !== 'keyword_match') return true
  const cfg = automation.trigger_config as KeywordMatchTriggerConfig
  if (!cfg?.keywords || cfg.keywords.length === 0) return false
  const text = (ctx?.message_text ?? '').toString()
  if (!text) return false
  const haystack = cfg.case_sensitive ? text : text.toLowerCase()
  return cfg.keywords.some((raw) => {
    const k = cfg.case_sensitive ? raw : raw.toLowerCase()
    return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k)
  })
}

async function evaluateCondition(cfg: ConditionStepConfig, args: ExecuteArgs): Promise<boolean> {
  switch (cfg.subject) {
    case 'tag_presence': {
      if (!args.contactId || !cfg.operand) return false
      // contact_tags has no account_id column, so tenant scoping here
      // relies on the contact-ownership guard in runAutomationsForTrigger.
      const { n } = firstOrThrow(
        await db
          .select({ n: count() })
          .from(contactTags)
          .where(
            and(
              eq(contactTags.contactId, args.contactId),
              eq(contactTags.tagId, cfg.operand),
            ),
          ),
      )
      return n > 0
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false
      // Scope to the account so the condition can't be turned into a
      // cross-tenant read oracle via the shared client.
      const row = firstOrNull(
        await db
          .select()
          .from(contacts)
          .where(
            and(
              eq(contacts.id, args.contactId),
              eq(contacts.accountId, args.automation.account_id),
            ),
          )
          .limit(1),
      )
      // The step config addresses columns by their snake_case DB name;
      // the Drizzle row is camelCase — translate before indexing.
      const camelKey = cfg.operand.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
      const v = (row as Record<string, unknown> | null)?.[camelKey]
      return v != null && String(v) === String(cfg.value ?? '')
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString()
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase())
    }
    case 'time_of_day': {
      // operand form "HH:mm-HH:mm" — true if now is within that window
      // (supports over-midnight ranges like "18:00-09:00").
      const [from, to] = (cfg.operand ?? '').split('-')
      if (!from || !to) return false
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number)
        return (h || 0) * 60 + (m || 0)
      }
      const f = parse(from)
      const t = parse(to)
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t
    }
    default:
      return false
  }
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs = cfg.unit === 'days' ? 86_400_000 : cfg.unit === 'hours' ? 3_600_000 : 60_000
  return Math.max(1_000, cfg.amount * unitMs)
}

function interpolate(s: string, args: ExecuteArgs): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.')
    if (ns === 'message' && prop === 'text') return String(args.context.message_text ?? '')
    if (ns === 'vars' && prop) return String(args.context.vars?.[prop] ?? '')
    return ''
  })
}

async function appendResults(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed' | null,
  errorMessage: string | null,
) {
  if (!logId) return
  // Log bookkeeping failures were always non-fatal (the old client
  // returned errors that this helper ignored) — keep that semantic.
  try {
    const existing = firstOrNull(
      await db
        .select({
          steps_executed: automationLogs.stepsExecuted,
          status: automationLogs.status,
        })
        .from(automationLogs)
        .where(eq(automationLogs.id, logId))
        .limit(1),
    )
    const merged = [
      ...((existing?.steps_executed as AutomationLogStepResult[] | undefined) ?? []),
      ...newItems,
    ]
    const update: Partial<typeof automationLogs.$inferInsert> = { stepsExecuted: merged }
    // Only overwrite status on the outermost scope — nested branches pass null.
    if (status !== null) {
      update.status = status
    }
    if (errorMessage) update.errorMessage = errorMessage
    await db.update(automationLogs).set(update).where(eq(automationLogs.id, logId))
  } catch (err) {
    console.error('[automations] appendResults failed:', err)
  }
}

async function finalizeLog(
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null,
) {
  if (!logId) return
  try {
    await db
      .update(automationLogs)
      .set({ status, errorMessage })
      .where(eq(automationLogs.id, logId))
  } catch (err) {
    console.error('[automations] finalizeLog failed:', err)
  }
}

async function markPending(id: string, status: 'done' | 'failed') {
  try {
    await db
      .update(automationPendingExecutions)
      .set({ status })
      .where(eq(automationPendingExecutions.id, id))
  } catch (err) {
    console.error('[automations] markPending failed:', err)
  }
}
