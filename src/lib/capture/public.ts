// Loader PÚBLICO (sem auth) de um formulário de captação pelo slug. Usado pela
// página /f/[slug] e pelo endpoint de submissão. Sem 'server-only'.

import { and, eq } from 'drizzle-orm'

import { db, captureForms, channels } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadDefaultChannel } from '@/lib/channels/channels'
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
  waRef: string | null
  successOfferTitle: string | null
  successOfferText: string | null
  successWhatsapp: boolean
  cadenceId: string | null
  pipelineId: string | null
  stageId: string | null
  origin: string
  theme: string
  createdBy: string | null
}

/**
 * Link wa.me do botão "Chamar no WhatsApp" da tela de sucesso: número do canal
 * do form (⚡) ou do canal padrão, com a mensagem pré-preenchida carregando o
 * ref rastreado. null quando a conta não tem canal com número.
 */
export async function getPublicCaptureWaHref(
  form: PublicCaptureForm,
): Promise<string | null> {
  try {
    let phoneRaw = ''
    if (form.introChannelId) {
      const ch = firstOrNull(
        await db
          .select({ phone: channels.phoneNumber })
          .from(channels)
          .where(
            and(eq(channels.id, form.introChannelId), eq(channels.accountId, form.accountId)),
          )
          .limit(1),
      )
      phoneRaw = ch?.phone ?? ''
    }
    if (!phoneRaw) {
      const def = await loadDefaultChannel(form.accountId)
      phoneRaw = def?.phoneNumber ?? ''
    }
    const phone = phoneRaw.replace(/\D/g, '')
    if (!phone) return null
    const ref = (form.waRef ?? '').toUpperCase()
    const message = ref
      ? `Olá! Acabei de enviar o formulário. #${ref}`
      : 'Olá! Acabei de enviar o formulário.'
    return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`
  } catch {
    return null
  }
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
    waRef: row.waRef,
    successOfferTitle: row.successOfferTitle,
    successOfferText: row.successOfferText,
    successWhatsapp: row.successWhatsapp,
    cadenceId: row.cadenceId,
    pipelineId: row.pipelineId,
    stageId: row.stageId,
    origin: row.origin,
    theme: row.theme,
    createdBy: row.createdBy,
  }
}
