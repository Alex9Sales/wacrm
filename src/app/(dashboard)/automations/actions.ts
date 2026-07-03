'use server'

// ============================================================
// Server actions for the Automations builder. Replaces the Supabase
// browser-client reads the builder used pre-Drizzle to populate its
// resource pickers (tags, approved templates, custom fields,
// pipelines + stages). Every query is scoped to the caller's account
// — there is no RLS anymore.
// ============================================================

import { and, asc, eq } from 'drizzle-orm'
import {
  db,
  tags,
  messageTemplates,
  customFields,
  pipelines,
  pipelineStages,
} from '@/db'
import { getCurrentAccount } from '@/lib/auth/account'
import type { Tag, CustomField, MessageTemplate } from '@/types'

interface PipelineOption {
  id: string
  name: string
}

interface PipelineStageOption {
  id: string
  name: string
  pipeline_id: string
  position: number
}

export interface AutomationResources {
  tags: Tag[]
  templates: MessageTemplate[]
  customFields: CustomField[]
  pipelines: PipelineOption[]
  stages: PipelineStageOption[]
}

/**
 * All the picker resources the builder needs in one round trip. Only
 * APPROVED templates are returned — anything else 400s at send time,
 * matching the broadcast picker. Everything is account-scoped.
 */
export async function getAutomationResources(): Promise<AutomationResources> {
  const ctx = await getCurrentAccount()

  const [tagRows, templateRows, customFieldRows, pipelineRows, stageRows] =
    await Promise.all([
      db
        .select({
          id: tags.id,
          user_id: tags.userId,
          account_id: tags.accountId,
          name: tags.name,
          color: tags.color,
          created_at: tags.createdAt,
        })
        .from(tags)
        .where(eq(tags.accountId, ctx.accountId))
        .orderBy(asc(tags.name)),
      db
        .select()
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.accountId, ctx.accountId),
            eq(messageTemplates.status, 'APPROVED'),
          ),
        )
        .orderBy(asc(messageTemplates.name)),
      db
        .select({
          id: customFields.id,
          user_id: customFields.userId,
          account_id: customFields.accountId,
          field_name: customFields.fieldName,
          field_type: customFields.fieldType,
          field_options: customFields.fieldOptions,
          created_at: customFields.createdAt,
        })
        .from(customFields)
        .where(eq(customFields.accountId, ctx.accountId))
        .orderBy(asc(customFields.fieldName)),
      db
        .select({ id: pipelines.id, name: pipelines.name })
        .from(pipelines)
        .where(eq(pipelines.accountId, ctx.accountId))
        .orderBy(asc(pipelines.name)),
      db
        .select({
          id: pipelineStages.id,
          name: pipelineStages.name,
          pipeline_id: pipelineStages.pipelineId,
          position: pipelineStages.position,
        })
        .from(pipelineStages)
        .innerJoin(pipelines, eq(pipelineStages.pipelineId, pipelines.id))
        .where(eq(pipelines.accountId, ctx.accountId))
        .orderBy(asc(pipelineStages.position)),
    ])

  return {
    tags: tagRows as unknown as Tag[],
    templates: templateRows as unknown as MessageTemplate[],
    customFields: customFieldRows as unknown as CustomField[],
    pipelines: pipelineRows as PipelineOption[],
    stages: stageRows as PipelineStageOption[],
  }
}
