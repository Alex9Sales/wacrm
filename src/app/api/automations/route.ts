import { NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'
import { db, automations } from '@/db'
import { firstOrThrow } from '@/db/helpers'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { getTemplate } from '@/lib/automations/templates'
import { insertSteps, type BuilderStepInput } from '@/lib/automations/steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'

// Snake_case projection so the JSON shape matches the old
// PostgREST `select('*')` responses the UI consumes.
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

export async function GET() {
  try {
    const ctx = await getCurrentAccount()

    const data = await db
      .select(automationColumns)
      .from(automations)
      .where(eq(automations.accountId, ctx.accountId))
      .orderBy(desc(automations.createdAt))

    return NextResponse.json({ automations: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    // Resolves the caller's account_id — `automations.account_id` is
    // NOT NULL post-017, so an INSERT without it trips the constraint.
    const ctx = await getCurrentAccount()

    const body = await request.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

    const { name, description, trigger_type, trigger_config, is_active, steps, template } = body

    let effectiveSteps: BuilderStepInput[] | undefined = steps
    let effectiveName = name
    let effectiveDescription = description
    let effectiveTriggerType = trigger_type
    let effectiveTriggerConfig = trigger_config

    if (template && (!steps || steps.length === 0)) {
      const t = getTemplate(template)
      if (t) {
        effectiveName = effectiveName ?? t.name
        effectiveDescription = effectiveDescription ?? t.description
        effectiveTriggerType = effectiveTriggerType ?? t.trigger_type
        effectiveTriggerConfig = effectiveTriggerConfig ?? t.trigger_config
        effectiveSteps = t.steps as unknown as BuilderStepInput[]
      }
    }

    if (!effectiveName || !effectiveTriggerType) {
      return NextResponse.json(
        { error: 'name and trigger_type are required' },
        { status: 400 },
      )
    }

    // Block activation of a clearly broken automation up-front instead of
    // letting every trigger silently produce a failed log row. Drafts
    // (is_active=false) are allowed to be incomplete so users can save
    // progress mid-build.
    if (is_active) {
      const issues = [
        ...validateTriggerForActivation(effectiveTriggerType, effectiveTriggerConfig ?? {}),
        ...validateStepsForActivation(
          (effectiveSteps ?? []) as unknown as { step_type: string; step_config: Record<string, unknown> }[],
        ),
      ]
      if (issues.length > 0) {
        return NextResponse.json(
          { error: 'Cannot activate automation with invalid configuration', issues },
          { status: 400 },
        )
      }
    }

    const automation = firstOrThrow(
      await db
        .insert(automations)
        .values({
          userId: ctx.userId,
          accountId: ctx.accountId,
          name: effectiveName,
          description: effectiveDescription ?? null,
          triggerType: effectiveTriggerType,
          triggerConfig: effectiveTriggerConfig ?? {},
          isActive: !!is_active,
        })
        .returning(automationColumns),
      'insert failed',
    )

    if (effectiveSteps && effectiveSteps.length > 0) {
      const err = await insertSteps(automation.id, effectiveSteps)
      if (err) return NextResponse.json({ error: err }, { status: 500 })
    }

    return NextResponse.json({ automation }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
