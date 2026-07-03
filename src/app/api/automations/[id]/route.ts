import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db, automations } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import {
  loadStepsTree,
  replaceSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'

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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await getCurrentAccount()

    const automation = firstOrNull(
      await db
        .select(automationColumns)
        .from(automations)
        .where(and(eq(automations.id, id), eq(automations.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const steps = await loadStepsTree(id)
    return NextResponse.json({ automation, steps })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await getCurrentAccount()

    const body = await request.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

    // Ownership check before we touch anything. Load the fields we need
    // to compute the post-patch "effective" state for validation.
    const existing = firstOrNull(
      await db
        .select({
          id: automations.id,
          is_active: automations.isActive,
          trigger_type: automations.triggerType,
          trigger_config: automations.triggerConfig,
        })
        .from(automations)
        .where(and(eq(automations.id, id), eq(automations.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const update: {
      name?: string
      description?: string | null
      triggerType?: string
      triggerConfig?: Record<string, unknown>
      isActive?: boolean
    } = {}
    if ('name' in body) update.name = body.name
    if ('description' in body) update.description = body.description
    if ('trigger_type' in body) update.triggerType = body.trigger_type
    if ('trigger_config' in body) update.triggerConfig = body.trigger_config
    if ('is_active' in body) update.isActive = body.is_active

    // If this PATCH leaves the automation active (either explicitly
    // activating it OR editing an already-active one), validate the
    // merged configuration first. Activation is the natural gate — drafts
    // are still allowed to be incomplete.
    const willBeActive =
      typeof update.isActive === 'boolean' ? update.isActive : existing.is_active
    if (willBeActive) {
      const mergedTriggerType = (update.triggerType ?? existing.trigger_type) as string
      const mergedTriggerConfig = update.triggerConfig ?? existing.trigger_config
      const mergedSteps = Array.isArray(body.steps)
        ? (body.steps as { step_type: string; step_config: Record<string, unknown> }[])
        : await loadStepsTree(id)
      const issues = [
        ...validateTriggerForActivation(
          mergedTriggerType,
          mergedTriggerConfig as Record<string, unknown>,
        ),
        ...validateStepsForActivation(mergedSteps),
      ]
      if (issues.length > 0) {
        return NextResponse.json(
          {
            error: 'Cannot keep automation active with invalid configuration',
            issues,
          },
          { status: 400 },
        )
      }
    }

    if (Object.keys(update).length > 0) {
      await db
        .update(automations)
        .set(update)
        .where(and(eq(automations.id, id), eq(automations.accountId, ctx.accountId)))
    }

    if (Array.isArray(body.steps)) {
      const err = await replaceSteps(id, body.steps as BuilderStepInput[])
      if (err) return NextResponse.json({ error: err }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await getCurrentAccount()

    await db
      .delete(automations)
      .where(and(eq(automations.id, id), eq(automations.accountId, ctx.accountId)))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
