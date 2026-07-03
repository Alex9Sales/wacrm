import { NextResponse } from 'next/server'
import { and, asc, eq } from 'drizzle-orm'
import { db, automations, automationSteps } from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

// Snake_case projection matching the old PostgREST `select('*')` shape.
const automationColumns = {
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
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await getCurrentAccount()

    const original = firstOrNull(
      await db
        .select(automationColumns)
        .from(automations)
        .where(and(eq(automations.id, id), eq(automations.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!original) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const copy = firstOrThrow(
      await db
        .insert(automations)
        .values({
          // Clone into the same account as the original. account_id is NOT
          // NULL post-017, so the INSERT fails the constraint without it.
          accountId: original.account_id,
          userId: ctx.userId,
          name: `${original.name} (Copy)`,
          description: original.description,
          triggerType: original.trigger_type,
          triggerConfig: original.trigger_config as Record<string, unknown>,
          isActive: false,
        })
        .returning(automationColumns),
      'copy failed',
    )

    const steps = await db
      .select({
        id: automationSteps.id,
        parent_step_id: automationSteps.parentStepId,
        branch: automationSteps.branch,
        step_type: automationSteps.stepType,
        step_config: automationSteps.stepConfig,
        position: automationSteps.position,
      })
      .from(automationSteps)
      .where(eq(automationSteps.automationId, id))
      .orderBy(asc(automationSteps.position))

    if (steps.length > 0) {
      // Re-map parent_step_id: build old→new id map first so the second
      // pass inserts rows with correct parent references.
      const idMap = new Map<string, string>()
      const uid = () =>
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2) + Date.now().toString(36)
      for (const row of steps) idMap.set(row.id, uid())

      const rows = steps.map((row) => ({
        id: idMap.get(row.id)!,
        automationId: copy.id,
        parentStepId: row.parent_step_id ? idMap.get(row.parent_step_id) ?? null : null,
        branch: row.branch,
        stepType: row.step_type,
        stepConfig: row.step_config as Record<string, unknown>,
        position: row.position,
      }))
      await db.insert(automationSteps).values(rows)
    }

    return NextResponse.json({ automation: copy }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
