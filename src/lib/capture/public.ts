// Loader PÚBLICO (sem auth) de um formulário de captação pelo slug. Usado pela
// página /f/[slug] e pelo endpoint de submissão. Sem 'server-only'.

import { and, eq } from 'drizzle-orm'

import { db, captureForms } from '@/db'
import { firstOrNull } from '@/db/helpers'
import {
  normalizeCaptureFields,
  normalizeCaptureContent,
  type CaptureField,
  type CaptureContent,
} from './shared'

export interface PublicCaptureForm {
  id: string
  accountId: string
  slug: string
  name: string
  headline: string | null
  description: string | null
  successMessage: string | null
  submitLabel: string | null
  fields: CaptureField[]
  content: CaptureContent
  aiIntro: boolean
  introChannelId: string | null
  pipelineId: string | null
  stageId: string | null
  origin: string
  theme: string
  createdBy: string | null
}

export async function getPublicCaptureForm(
  slug: string,
): Promise<PublicCaptureForm | null> {
  if (!slug || typeof slug !== 'string' || slug.length > 80) return null
  const row = firstOrNull(
    await db
      .select()
      .from(captureForms)
      .where(and(eq(captureForms.slug, slug), eq(captureForms.active, true)))
      .limit(1),
  )
  if (!row) return null
  return {
    id: row.id,
    accountId: row.accountId,
    slug: row.slug,
    name: row.name,
    headline: row.headline,
    description: row.description,
    successMessage: row.successMessage,
    submitLabel: row.submitLabel,
    fields: normalizeCaptureFields(row.fields),
    content: normalizeCaptureContent(row.content),
    aiIntro: row.aiIntro,
    introChannelId: row.introChannelId,
    pipelineId: row.pipelineId,
    stageId: row.stageId,
    origin: row.origin,
    theme: row.theme,
    createdBy: row.createdBy,
  }
}
