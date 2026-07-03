'use server'

// ============================================================
// Server action for the automation logs viewer. Replaces the
// Supabase browser-client queries the page used pre-Drizzle.
// Account-scoped — there is no RLS anymore.
// ============================================================

import { and, desc, eq } from 'drizzle-orm'
import { db, automations, automationLogs, contacts } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import type { Automation, AutomationLog } from '@/types'

/**
 * The automation (or null when it doesn't exist / belongs to another
 * account) plus its 100 most recent logs with a minimal contact embed
 * — mirrors the old `select('*, contact:contacts(id, name, phone)')`.
 */
export async function getAutomationWithLogs(automationId: string): Promise<{
  automation: Automation | null
  logs: AutomationLog[]
}> {
  const ctx = await getCurrentAccount()

  const automation = firstOrNull(
    await db
      .select({
        id: automations.id,
        user_id: automations.userId,
        account_id: automations.accountId,
        name: automations.name,
        description: automations.description,
        trigger_type: automations.triggerType,
        trigger_config: automations.triggerConfig,
        is_active: automations.isActive,
        execution_count: automations.executionCount,
        last_executed_at: automations.lastExecutedAt,
        created_at: automations.createdAt,
        updated_at: automations.updatedAt,
      })
      .from(automations)
      .where(and(eq(automations.id, automationId), eq(automations.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!automation) return { automation: null, logs: [] }

  const logRows = await db
    .select({
      id: automationLogs.id,
      automation_id: automationLogs.automationId,
      user_id: automationLogs.userId,
      account_id: automationLogs.accountId,
      contact_id: automationLogs.contactId,
      trigger_event: automationLogs.triggerEvent,
      steps_executed: automationLogs.stepsExecuted,
      status: automationLogs.status,
      error_message: automationLogs.errorMessage,
      created_at: automationLogs.createdAt,
      contact: {
        id: contacts.id,
        name: contacts.name,
        phone: contacts.phone,
      },
    })
    .from(automationLogs)
    .leftJoin(contacts, eq(automationLogs.contactId, contacts.id))
    .where(
      and(
        eq(automationLogs.automationId, automationId),
        eq(automationLogs.accountId, ctx.accountId),
      ),
    )
    .orderBy(desc(automationLogs.createdAt))
    .limit(100)

  const logs = logRows.map((r) => ({
    ...r,
    contact: r.contact?.id ? r.contact : undefined,
  })) as unknown as AutomationLog[]

  return { automation: automation as unknown as Automation, logs }
}
