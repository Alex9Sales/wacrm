'use server'

import { and, asc, desc, eq } from 'drizzle-orm'

import { db, captureForms, pipelines, pipelineStages, channels } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import {
  normalizeCaptureFields,
  normalizeCaptureContent,
  slugifyName,
  type CaptureField,
  type CaptureContent,
} from '@/lib/capture/shared'

const APP_URL = (
  process.env.APP_URL || 'https://crm.salestecnologia.com.br'
).replace(/\/$/, '')

function capturePublicUrl(slug: string): string {
  return `${APP_URL}/f/${slug}`
}

export interface CaptureFormRow {
  id: string
  name: string
  slug: string
  publicUrl: string
  origin: string
  active: boolean
  submissions: number
  pipelineName: string | null
  /** 'landing' quando a página pública é a landing completa. */
  mode: 'form' | 'landing'
}

export interface CaptureFormDetail {
  id: string
  name: string
  slug: string
  publicUrl: string
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
  active: boolean
  submissions: number
}

export interface CaptureFormInput {
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
  active: boolean
}

export async function listCaptureForms(): Promise<CaptureFormRow[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: captureForms.id,
      name: captureForms.name,
      slug: captureForms.slug,
      origin: captureForms.origin,
      active: captureForms.active,
      submissions: captureForms.submissions,
      pipelineName: pipelines.name,
      content: captureForms.content,
    })
    .from(captureForms)
    .leftJoin(pipelines, eq(pipelines.id, captureForms.pipelineId))
    .where(eq(captureForms.accountId, ctx.accountId))
    .orderBy(desc(captureForms.createdAt))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    origin: r.origin,
    active: r.active,
    submissions: r.submissions,
    publicUrl: capturePublicUrl(r.slug),
    pipelineName: r.pipelineName ?? null,
    mode: normalizeCaptureContent(r.content).mode,
  }))
}

export async function getCaptureForm(
  id: string,
): Promise<CaptureFormDetail | null> {
  const ctx = await getCurrentAccount()
  const row = firstOrNull(
    await db
      .select()
      .from(captureForms)
      .where(and(eq(captureForms.id, id), eq(captureForms.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    publicUrl: capturePublicUrl(row.slug),
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
    active: row.active,
    submissions: row.submissions,
  }
}

/** Gera um slug único (base do nome + sufixo curto), tentando de novo em colisão. */
async function uniqueSlug(name: string): Promise<string> {
  const base = slugifyName(name) || 'formulario'
  for (let i = 0; i < 6; i++) {
    const suffix = Math.random().toString(36).slice(2, 7)
    const slug = `${base}-${suffix}`
    const taken = firstOrNull(
      await db
        .select({ id: captureForms.id })
        .from(captureForms)
        .where(eq(captureForms.slug, slug))
        .limit(1),
    )
    if (!taken) return slug
  }
  return `${base}-${Date.now().toString(36)}`
}

export async function createCaptureForm(
  input: CaptureFormInput,
): Promise<{ id: string | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const name = (input.name ?? '').trim()
    if (!name) return { id: null, error: 'Dê um nome ao formulário.' }
    const slug = await uniqueSlug(name)
    try {
      const row = await db
        .insert(captureForms)
        .values({
          accountId: ctx.accountId,
          slug,
          name,
          headline: (input.headline ?? '').trim() || null,
          description: (input.description ?? '').trim() || null,
          successMessage: (input.successMessage ?? '').trim() || null,
          submitLabel: (input.submitLabel ?? '').trim() || null,
          fields: normalizeCaptureFields(input.fields),
          content: normalizeCaptureContent(input.content),
          aiIntro: !!input.aiIntro,
          introChannelId: input.introChannelId || null,
          pipelineId: input.pipelineId || null,
          stageId: input.stageId || null,
          origin: (input.origin ?? '').trim() || 'Formulário',
          active: input.active ?? true,
          createdBy: ctx.userId,
        })
        .returning({ id: captureForms.id })
      return { id: row[0]?.id ?? null, error: null }
    } catch (err) {
      if (isUniqueViolation(err)) {
        return { id: null, error: 'Não foi possível gerar o link. Tente de novo.' }
      }
      throw err
    }
  } catch (err) {
    console.error('[createCaptureForm]', err)
    return { id: null, error: 'Falha ao criar o formulário.' }
  }
}

export async function updateCaptureForm(
  id: string,
  input: CaptureFormInput,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const name = (input.name ?? '').trim()
    if (!name) return { error: 'Dê um nome ao formulário.' }
    const owned = firstOrNull(
      await db
        .select({ id: captureForms.id })
        .from(captureForms)
        .where(and(eq(captureForms.id, id), eq(captureForms.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!owned) return { error: 'Formulário não encontrado.' }
    await db
      .update(captureForms)
      .set({
        name,
        headline: (input.headline ?? '').trim() || null,
        description: (input.description ?? '').trim() || null,
        successMessage: (input.successMessage ?? '').trim() || null,
        submitLabel: (input.submitLabel ?? '').trim() || null,
        fields: normalizeCaptureFields(input.fields),
        content: normalizeCaptureContent(input.content),
        aiIntro: !!input.aiIntro,
        introChannelId: input.introChannelId || null,
        pipelineId: input.pipelineId || null,
        stageId: input.stageId || null,
        origin: (input.origin ?? '').trim() || 'Formulário',
        active: input.active ?? true,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(captureForms.id, id), eq(captureForms.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    console.error('[updateCaptureForm]', err)
    return { error: 'Falha ao salvar o formulário.' }
  }
}

export async function deleteCaptureForm(
  id: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .delete(captureForms)
      .where(and(eq(captureForms.id, id), eq(captureForms.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    console.error('[deleteCaptureForm]', err)
    return { error: 'Falha ao excluir o formulário.' }
  }
}

/** Canais WhatsApp da conta — seletor do "IA no Segundo Zero". */
export async function listCaptureChannels(): Promise<
  { id: string; name: string }[]
> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({ id: channels.id, name: channels.name, provider: channels.provider })
    .from(channels)
    .where(eq(channels.accountId, ctx.accountId))
  return rows
    .filter((c) => ['waha', 'meta', 'evolution', 'evogo'].includes(c.provider))
    .map((c) => ({ id: c.id, name: c.name }))
}

/** Funis + etapas da conta pro seletor de destino do formulário. */
export async function listCapturePipelines(): Promise<
  { id: string; name: string; stages: { id: string; name: string }[] }[]
> {
  const ctx = await getCurrentAccount()
  const [pips, stgs] = await Promise.all([
    db
      .select({ id: pipelines.id, name: pipelines.name })
      .from(pipelines)
      .where(eq(pipelines.accountId, ctx.accountId))
      .orderBy(asc(pipelines.name)),
    db
      .select({
        id: pipelineStages.id,
        name: pipelineStages.name,
        pipelineId: pipelineStages.pipelineId,
        position: pipelineStages.position,
      })
      .from(pipelineStages)
      .innerJoin(pipelines, eq(pipelines.id, pipelineStages.pipelineId))
      .where(eq(pipelines.accountId, ctx.accountId))
      .orderBy(asc(pipelineStages.position)),
  ])
  return pips.map((p) => ({
    id: p.id,
    name: p.name,
    stages: stgs
      .filter((s) => s.pipelineId === p.id)
      .map((s) => ({ id: s.id, name: s.name })),
  }))
}
