'use server'

import { and, asc, desc, eq, sql } from 'drizzle-orm'

import { db, captureForms, pipelines, pipelineStages, channels, products } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { getCompanyProfile } from '@/lib/ai/company-profile'
import {
  normalizeCaptureFields,
  normalizeCaptureContent,
  slugifyName,
  type CaptureField,
  type CaptureContent,
} from '@/lib/capture/shared'
import { randomWaRef } from '@/lib/capture/wa-ref'
import { loadDefaultChannel } from '@/lib/channels/channels'

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

/** Gera um wa_ref único (colisão é raríssima; tenta algumas vezes). */
async function uniqueWaRef(): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const ref = randomWaRef()
    const taken = firstOrNull(
      await db
        .select({ id: captureForms.id })
        .from(captureForms)
        .where(sql`upper(${captureForms.waRef}) = ${ref}`)
        .limit(1),
    )
    if (!taken) return ref
  }
  return randomWaRef(8)
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
    const waRef = await uniqueWaRef()
    try {
      const row = await db
        .insert(captureForms)
        .values({
          accountId: ctx.accountId,
          slug,
          waRef,
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

// ------------------------------------------------------------
// Landing em 1 clique — a IA (que já conhece o negócio: perfil da empresa +
// catálogo) escreve a landing inteira: headline, descrição, CTA, benefícios,
// botão e mensagem de sucesso. O dono só revisa e salva. Nunca inventa
// depoimentos (prova social é real ou nada).
// ------------------------------------------------------------
export interface GeneratedLanding {
  headline: string
  description: string
  ctaText: string
  benefitsTitle: string
  benefits: { title: string; description: string }[]
  submitLabel: string
  successMessage: string
}

export async function generateCaptureLanding(
  briefing: string,
): Promise<{ data: GeneratedLanding | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const config = await loadAiConfig(ctx.accountId, { requireActive: false })
    if (!config) {
      return {
        data: null,
        error:
          'Configure um agente de IA (com chave) em Agentes IA para gerar a landing.',
      }
    }

    const [profile, prods] = await Promise.all([
      getCompanyProfile(ctx.accountId),
      db
        .select({ name: products.name, description: products.description })
        .from(products)
        .where(and(eq(products.accountId, ctx.accountId), eq(products.active, true)))
        .limit(8),
    ])

    const empresa =
      profile.trade_name || profile.business_name || '(nome não informado)'
    const contexto = [
      `Empresa: ${empresa}`,
      profile.description ? `Sobre: ${profile.description}` : '',
      profile.offerings ? `Produtos/serviços: ${profile.offerings}` : '',
      prods.length
        ? `Catálogo: ${prods
            .map((p) => p.name + (p.description ? ` (${p.description})` : ''))
            .join('; ')}`
        : '',
      briefing.trim() ? `Objetivo desta página (do dono): ${briefing.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    const systemPrompt = [
      'Você é um copywriter brasileiro especialista em landing pages de captação que CONVERTEM.',
      'Escreva em português do Brasil, direto, concreto e sem clichê de marketing ("soluções inovadoras", "líder de mercado" etc. são PROIBIDOS).',
      'A página termina num formulário de WhatsApp — todo o texto empurra a pessoa a deixar o contato.',
      'NUNCA invente depoimentos, números ou clientes.',
      'Responda APENAS com um JSON válido, sem comentários e sem markdown, neste formato exato:',
      '{"headline": "...", "description": "...", "ctaText": "...", "benefitsTitle": "...", "benefits": [{"title": "...", "description": "..."}, {"title": "...", "description": "..."}, {"title": "...", "description": "..."}], "submitLabel": "...", "successMessage": "..."}',
      'Regras: headline com no máximo 9 palavras (benefício claro, pode 1 emoji); description com 1-2 frases; ctaText e submitLabel curtos (2-4 palavras, 1ª pessoa tipo "Quero..."); benefitsTitle curto; exatamente 3 benefits (title 2-5 palavras, description 1 frase concreta); successMessage calorosa dizendo que a equipe chama no WhatsApp.',
    ].join('\n')

    const result = await generateReply({
      config,
      systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Dados do negócio:\n${contexto}\n\nGere o JSON da landing.`,
        },
      ],
      meta: {
        accountId: ctx.accountId,
        agentId: config.id ?? null,
        channelId: null,
        source: 'capture',
      },
    })

    // Parse robusto: tira cerca de código e pega o primeiro objeto JSON.
    const raw = result.text.replace(/```(?:json)?/gi, '').trim()
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) {
      return { data: null, error: 'A IA não retornou um formato válido. Tente de novo.' }
    }
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<GeneratedLanding>
    const s = (v: unknown, max: number) =>
      typeof v === 'string' ? v.trim().slice(0, max) : ''
    const benefits = (Array.isArray(parsed.benefits) ? parsed.benefits : [])
      .map((b) => ({
        title: s((b as { title?: unknown })?.title, 120),
        description: s((b as { description?: unknown })?.description, 300),
      }))
      .filter((b) => b.title)
      .slice(0, 6)
    const data: GeneratedLanding = {
      headline: s(parsed.headline, 160),
      description: s(parsed.description, 400),
      ctaText: s(parsed.ctaText, 40),
      benefitsTitle: s(parsed.benefitsTitle, 120),
      benefits,
      submitLabel: s(parsed.submitLabel, 40),
      successMessage: s(parsed.successMessage, 400),
    }
    if (!data.headline || benefits.length === 0) {
      return { data: null, error: 'A IA não retornou um formato válido. Tente de novo.' }
    }
    return { data, error: null }
  } catch (err) {
    console.error('[generateCaptureLanding]', err)
    return {
      data: null,
      error: 'Falha ao gerar com a IA. Confira a chave do agente e tente de novo.',
    }
  }
}

// ------------------------------------------------------------
// Link Zap + QR rastreado: link wa.me com o ref do formulário embutido na
// mensagem pré-preenchida. O número é o do canal do form (⚡) ou o padrão.
// ------------------------------------------------------------
export interface CaptureWaInfo {
  link: string
  ref: string
  phone: string
  channelName: string
  message: string
}

export async function getCaptureWaInfo(
  formId: string,
): Promise<{ data: CaptureWaInfo | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const form = firstOrNull(
      await db
        .select({
          waRef: captureForms.waRef,
          introChannelId: captureForms.introChannelId,
        })
        .from(captureForms)
        .where(and(eq(captureForms.id, formId), eq(captureForms.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!form) return { data: null, error: 'Formulário não encontrado.' }

    // Garante o ref (forms antigos podem não ter — gera e grava na hora).
    let ref = (form.waRef ?? '').toUpperCase()
    if (!ref) {
      ref = await uniqueWaRef()
      await db
        .update(captureForms)
        .set({ waRef: ref })
        .where(eq(captureForms.id, formId))
    }

    // Canal: o escolhido no ⚡ (se tiver telefone), senão o padrão da conta.
    let channelName = ''
    let phoneRaw = ''
    if (form.introChannelId) {
      const ch = firstOrNull(
        await db
          .select({ name: channels.name, phone: channels.phoneNumber })
          .from(channels)
          .where(and(eq(channels.id, form.introChannelId), eq(channels.accountId, ctx.accountId)))
          .limit(1),
      )
      if (ch?.phone) {
        channelName = ch.name
        phoneRaw = ch.phone
      }
    }
    if (!phoneRaw) {
      const def = await loadDefaultChannel(ctx.accountId)
      if (def?.phoneNumber) {
        channelName = def.name
        phoneRaw = def.phoneNumber
      }
    }
    const phone = phoneRaw.replace(/\D/g, '')
    if (!phone) {
      return {
        data: null,
        error: 'Nenhum canal WhatsApp com número encontrado. Conecte um canal primeiro.',
      }
    }

    const message = `Olá! Quero mais informações. #${ref}`
    const link = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`
    return { data: { link, ref, phone, channelName, message }, error: null }
  } catch (err) {
    console.error('[getCaptureWaInfo]', err)
    return { data: null, error: 'Falha ao montar o link do WhatsApp.' }
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
