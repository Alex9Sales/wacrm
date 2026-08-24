'use server'

import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm'

import {
  db,
  captureForms,
  pipelines,
  pipelineStages,
  channels,
  products,
  cadences,
  schedulers,
  member,
  user,
  deals,
  contactTags,
  tags,
  captureDomains,
} from '@/db'
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
import {
  addDomainToCoolify,
  removeDomainFromCoolify,
  triggerCoolifyDeploy,
} from '@/lib/capture/coolify'
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
  /** Tipo da página pública: formulário simples, landing completa ou quiz. */
  mode: 'form' | 'landing' | 'quiz'
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
  successOfferTitle: string | null
  successOfferText: string | null
  successWhatsapp: boolean
  cadenceId: string | null
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
  successOfferTitle: string | null
  successOfferText: string | null
  successWhatsapp: boolean
  cadenceId: string | null
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
    successOfferTitle: row.successOfferTitle,
    successOfferText: row.successOfferText,
    successWhatsapp: row.successWhatsapp,
    cadenceId: row.cadenceId,
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
          successOfferTitle: (input.successOfferTitle ?? '').trim() || null,
          successOfferText: (input.successOfferText ?? '').trim() || null,
          successWhatsapp: !!input.successWhatsapp,
          cadenceId: input.cadenceId || null,
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
        successOfferTitle: (input.successOfferTitle ?? '').trim() || null,
        successOfferText: (input.successOfferText ?? '').trim() || null,
        successWhatsapp: !!input.successWhatsapp,
        cadenceId: input.cadenceId || null,
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
      profile.tone ? `TOM DE VOZ da marca (escreva EXATAMENTE neste tom): ${profile.tone}` : '',
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
// Quiz em 1 clique — a IA escreve o quiz inteiro: título, descrição, 4-5
// perguntas de múltipla escolha que QUALIFICAM o lead (dor, urgência, porte)
// e as instruções do diagnóstico. O dono só revisa e salva.
// ------------------------------------------------------------
export interface GeneratedQuiz {
  headline: string
  description: string
  ctaStart: string
  questions: { text: string; type: 'choice' | 'text'; options: string[] }[]
  resultPrompt: string
}

export async function generateCaptureQuiz(
  briefing: string,
): Promise<{ data: GeneratedQuiz | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const config = await loadAiConfig(ctx.accountId, { requireActive: false })
    if (!config) {
      return {
        data: null,
        error:
          'Configure um agente de IA (com chave) em Agentes IA para gerar o quiz.',
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
      profile.tone ? `TOM DE VOZ da marca (escreva EXATAMENTE neste tom): ${profile.tone}` : '',
      profile.offerings ? `Produtos/serviços: ${profile.offerings}` : '',
      prods.length
        ? `Catálogo: ${prods
            .map((p) => p.name + (p.description ? ` (${p.description})` : ''))
            .join('; ')}`
        : '',
      briefing.trim() ? `Objetivo deste quiz (do dono): ${briefing.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    const systemPrompt = [
      'Você é especialista brasileiro em quizzes de captação (lead magnets interativos) que qualificam e convertem.',
      'Escreva em português do Brasil, direto e concreto, sem clichê de marketing.',
      'O quiz roda assim: a pessoa responde as perguntas → deixa o WhatsApp → recebe um diagnóstico personalizado da IA na tela. As perguntas devem revelar DOR, URGÊNCIA e PORTE/CONTEXTO do lead (é assim que a IA qualifica quente/morno/frio).',
      'Responda APENAS com um JSON válido, sem comentários e sem markdown, neste formato exato:',
      '{"headline": "...", "description": "...", "ctaStart": "...", "questions": [{"text": "...", "type": "choice", "options": ["...", "...", "..."]}], "resultPrompt": "..."}',
      'Regras: headline com no máximo 9 palavras prometendo o resultado do quiz (pode 1 emoji); description com 1-2 frases; ctaStart curto (2-4 palavras, ex.: "Começar agora"); 4 a 5 questions — as primeiras "choice" com 3-4 options curtas (máx. 6 palavras cada), a ÚLTIMA pode ser {"type": "text", "options": []} pedindo pra pessoa contar mais; resultPrompt = 2-3 frases instruindo a IA que escreverá o diagnóstico (papel, foco, o que recomendar).',
    ].join('\n')

    const result = await generateReply({
      config,
      systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Dados do negócio:\n${contexto}\n\nGere o JSON do quiz.`,
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
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<GeneratedQuiz>
    const s = (v: unknown, max: number) =>
      typeof v === 'string' ? v.trim().slice(0, max) : ''
    const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
      .map((q) => {
        const type =
          (q as { type?: unknown })?.type === 'text' ? ('text' as const) : ('choice' as const)
        return {
          text: s((q as { text?: unknown })?.text, 300),
          type,
          options:
            type === 'text'
              ? []
              : (Array.isArray((q as { options?: unknown })?.options)
                  ? ((q as { options: unknown[] }).options)
                  : []
                )
                  .map((op) => s(op, 120))
                  .filter(Boolean)
                  .slice(0, 6),
        }
      })
      .filter((q) => q.text && (q.type === 'text' || q.options.length >= 2))
      .slice(0, 10)
    const data: GeneratedQuiz = {
      headline: s(parsed.headline, 160),
      description: s(parsed.description, 400),
      ctaStart: s(parsed.ctaStart, 40),
      questions,
      resultPrompt: s(parsed.resultPrompt, 600),
    }
    if (!data.headline || questions.length < 3) {
      return { data: null, error: 'A IA não retornou um formato válido. Tente de novo.' }
    }
    return { data, error: null }
  } catch (err) {
    console.error('[generateCaptureQuiz]', err)
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

// ------------------------------------------------------------
// 📊 Raio-X de campanha — pra cada ativo de captação (formulário, landing,
// quiz, link zap rastreado, agenda), quantos leads ENTRARAM no período e no
// que deu: abertos, ganhos (com valor), perdidos, conversão. Cohort pelos
// deals criados no período (o que a captação gerou), casando pelo `source`
// que cada caminho grava ("Formulário: X", "Quiz: X", "Link WhatsApp: X",
// "Agendamento: X"). Quiz ganha o termômetro 🔥/🌤️/❄️ das etiquetas da IA.
// ------------------------------------------------------------
export interface XrayRow {
  source: string
  kind: 'form' | 'landing' | 'quiz' | 'whatsapp' | 'agenda' | 'chat'
  label: string
  leads: number
  open: number
  won: number
  lost: number
  wonValue: number
  quiz: { quente: number; morno: number; frio: number } | null
}

export interface CaptureXray {
  totals: { leads: number; open: number; won: number; lost: number; wonValue: number }
  rows: XrayRow[]
}

export async function getCaptureXray(days: number): Promise<CaptureXray> {
  const ctx = await getCurrentAccount()
  const since =
    days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null

  const sourceFilter = sql`${deals.source} ~ '^(Formulário|Quiz|Link WhatsApp|Agendamento|Chat): '`
  const conds = [eq(deals.accountId, ctx.accountId), sourceFilter]
  if (since) conds.push(gte(deals.createdAt, since))

  const [byStatus, quizTags, forms] = await Promise.all([
    db
      .select({
        source: deals.source,
        status: deals.status,
        n: sql<number>`count(*)::int`,
        value: sql<string>`coalesce(sum(${deals.value}), 0)::text`,
      })
      .from(deals)
      .where(and(...conds))
      .groupBy(deals.source, deals.status),
    // Termômetro do quiz: etiqueta atual da IA nos contatos desses leads.
    db
      .select({
        source: deals.source,
        tag: tags.name,
        n: sql<number>`count(DISTINCT ${deals.contactId})::int`,
      })
      .from(deals)
      .innerJoin(contactTags, eq(contactTags.contactId, deals.contactId))
      .innerJoin(tags, eq(tags.id, contactTags.tagId))
      .where(
        and(
          ...conds,
          sql`${deals.source} LIKE 'Quiz: %'`,
          inArray(tags.name, ['Quiz: quente', 'Quiz: morno', 'Quiz: frio']),
        ),
      )
      .groupBy(deals.source, tags.name),
    // Nome → modo, pra distinguir landing de formulário simples no selo.
    db
      .select({ name: captureForms.name, content: captureForms.content })
      .from(captureForms)
      .where(eq(captureForms.accountId, ctx.accountId)),
  ])

  const modeByName = new Map<string, 'form' | 'landing' | 'quiz'>()
  for (const f of forms)
    modeByName.set(f.name, normalizeCaptureContent(f.content).mode)

  const rowsBySource = new Map<string, XrayRow>()
  for (const r of byStatus) {
    const source = r.source ?? ''
    let row = rowsBySource.get(source)
    if (!row) {
      let kind: XrayRow['kind'] = 'form'
      let label = source
      if (source.startsWith('Quiz: ')) {
        kind = 'quiz'
        label = source.slice(6)
      } else if (source.startsWith('Link WhatsApp: ')) {
        kind = 'whatsapp'
        label = source.slice(15)
      } else if (source.startsWith('Agendamento: ')) {
        kind = 'agenda'
        label = source.slice(13)
      } else if (source.startsWith('Chat: ')) {
        kind = 'chat'
        label = source.slice(6)
      } else if (source.startsWith('Formulário: ')) {
        label = source.slice(12)
        kind = modeByName.get(label) === 'landing' ? 'landing' : 'form'
      }
      row = {
        source,
        kind,
        label,
        leads: 0,
        open: 0,
        won: 0,
        lost: 0,
        wonValue: 0,
        quiz: null,
      }
      rowsBySource.set(source, row)
    }
    row.leads += r.n
    if (r.status === 'won') {
      row.won += r.n
      row.wonValue += Number(r.value) || 0
    } else if (r.status === 'lost') row.lost += r.n
    else row.open += r.n
  }

  for (const q of quizTags) {
    const row = rowsBySource.get(q.source ?? '')
    if (!row) continue
    if (!row.quiz) row.quiz = { quente: 0, morno: 0, frio: 0 }
    if (q.tag === 'Quiz: quente') row.quiz.quente = q.n
    else if (q.tag === 'Quiz: morno') row.quiz.morno = q.n
    else if (q.tag === 'Quiz: frio') row.quiz.frio = q.n
  }

  const rows = [...rowsBySource.values()].sort((a, b) => b.leads - a.leads)
  const totals = rows.reduce(
    (acc, r) => ({
      leads: acc.leads + r.leads,
      open: acc.open + r.open,
      won: acc.won + r.won,
      lost: acc.lost + r.lost,
      wonValue: acc.wonValue + r.wonValue,
    }),
    { leads: 0, open: 0, won: 0, lost: 0, wonValue: 0 },
  )
  return { totals, rows }
}

// ------------------------------------------------------------
// 🌐 Domínio próprio: o cliente aponta um CNAME pro nosso host e as páginas
// de captação respondem no domínio DELE. Verificação por DNS-over-HTTPS
// (Cloudflare): CNAME pra *.salestecnologia.com.br OU A pro nosso IP.
// ------------------------------------------------------------
export interface CaptureDomainRow {
  id: string
  domain: string
  verified: boolean
}

const OUR_CNAME_SUFFIX = 'salestecnologia.com.br'
const OUR_IP = '72.60.137.234'
const DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62}){1,6}$/

export async function listCaptureDomains(): Promise<CaptureDomainRow[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: captureDomains.id,
      domain: captureDomains.domain,
      verified: captureDomains.verified,
    })
    .from(captureDomains)
    .where(eq(captureDomains.accountId, ctx.accountId))
    .orderBy(asc(captureDomains.domain))
  return rows
}

export async function addCaptureDomain(
  input: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const domain = (input ?? '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/[/?#].*$/, '')
      .replace(/:\d+$/, '')
      .replace(/\.$/, '')
    if (!DOMAIN_RE.test(domain)) {
      return { error: 'Domínio inválido — ex.: paginas.suaempresa.com.br' }
    }
    if (domain.endsWith(OUR_CNAME_SUFFIX)) {
      return { error: 'Use um domínio seu (esse é o nosso 🙂).' }
    }
    await db.insert(captureDomains).values({
      accountId: ctx.accountId,
      domain,
      createdBy: ctx.userId,
    })
    return { error: null }
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { error: 'Esse domínio já está cadastrado.' }
    }
    console.error('[addCaptureDomain]', err)
    return { error: 'Falha ao cadastrar o domínio.' }
  }
}

/** Consulta DoH da Cloudflare (JSON). Retorna os `data` das respostas. */
async function dohAnswers(name: string, type: 'CNAME' | 'A'): Promise<string[]> {
  try {
    const r = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { accept: 'application/dns-json' }, cache: 'no-store' },
    )
    if (!r.ok) return []
    const j = (await r.json()) as { Answer?: { type: number; data: string }[] }
    return (j.Answer ?? []).map((a) => a.data.toLowerCase().replace(/\.$/, ''))
  } catch {
    return []
  }
}

export async function verifyCaptureDomain(
  id: string,
): Promise<{ verified: boolean; error: string | null; sslQueued?: boolean }> {
  try {
    const ctx = await getCurrentAccount()
    const row = firstOrNull(
      await db
        .select({ id: captureDomains.id, domain: captureDomains.domain })
        .from(captureDomains)
        .where(and(eq(captureDomains.id, id), eq(captureDomains.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!row) return { verified: false, error: 'Domínio não encontrado.' }
    const [cnames, aRecords] = await Promise.all([
      dohAnswers(row.domain, 'CNAME'),
      dohAnswers(row.domain, 'A'),
    ])
    const ok =
      cnames.some((c) => c.endsWith(OUR_CNAME_SUFFIX)) ||
      aRecords.includes(OUR_IP)
    if (!ok) {
      return {
        verified: false,
        error:
          'DNS ainda não aponta pra gente. Confira o CNAME e aguarde a propagação (pode levar até 1h).',
      }
    }
    await db
      .update(captureDomains)
      .set({ verified: true, verifiedAt: new Date().toISOString() })
      .where(eq(captureDomains.id, row.id))
    // Ativação automática COMPLETA: domínio entra no proxy (Coolify) e, se o
    // fqdn mudou, já dispara o deploy que regenera o Traefik + emite o
    // certificado Let's Encrypt — zero passo manual. A chamada de deploy só
    // ENFILEIRA (retorna na hora); o recreate acontece async no Coolify.
    // Best-effort: falhou, o domínio segue verificado e a ativação sai manual.
    const ssl = await addDomainToCoolify(row.domain)
    if (!ssl.ok) console.warn('[verifyCaptureDomain] coolify:', ssl.detail)
    if (ssl.ok && ssl.changed) {
      const dep = await triggerCoolifyDeploy()
      if (!dep.ok) console.warn('[verifyCaptureDomain] deploy:', dep.detail)
    }
    return { verified: true, error: null, sslQueued: ssl.ok }
  } catch (err) {
    console.error('[verifyCaptureDomain]', err)
    return { verified: false, error: 'Falha ao verificar. Tente de novo.' }
  }
}

export async function deleteCaptureDomain(
  id: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const row = firstOrNull(
      await db
        .delete(captureDomains)
        .where(and(eq(captureDomains.id, id), eq(captureDomains.accountId, ctx.accountId)))
        .returning({ domain: captureDomains.domain, verified: captureDomains.verified }),
    )
    // Tira do proxy também (best-effort; sem deploy — a limpeza de rota/cert
    // pega carona no próximo deploy, e o conteúdo já morre na hora porque a
    // rota valida o domínio no banco a cada request).
    if (row?.verified) {
      const res = await removeDomainFromCoolify(row.domain)
      if (!res.ok) console.warn('[deleteCaptureDomain] coolify:', res.detail)
    }
    return { error: null }
  } catch (err) {
    console.error('[deleteCaptureDomain]', err)
    return { error: 'Falha ao remover o domínio.' }
  }
}

/** Cadências ativas (com degrau) — seletor do "Obrigado que Vende". */
export async function listCaptureCadences(): Promise<
  { id: string; name: string }[]
> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: cadences.id,
      name: cadences.name,
      steps: sql<number>`(SELECT count(*)::int FROM cadence_steps s WHERE s.cadence_id = ${cadences.id})`,
    })
    .from(cadences)
    .where(and(eq(cadences.accountId, ctx.accountId), eq(cadences.active, true)))
    .orderBy(asc(cadences.name))
  return rows.filter((r) => r.steps > 0).map((r) => ({ id: r.id, name: r.name }))
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

// ------------------------------------------------------------
// Página de agendamento pública (tipo Calendly) — gestão.
// ------------------------------------------------------------

export interface SchedulerWindowInput {
  open: string | null
  close: string | null
}

export interface SchedulerRow {
  id: string
  name: string
  slug: string
  publicUrl: string
  ownerName: string | null
  active: boolean
  bookings: number
}

export interface SchedulerDetail {
  id: string
  name: string
  slug: string
  publicUrl: string
  headline: string | null
  description: string | null
  userId: string
  durationMinutes: number
  availability: SchedulerWindowInput[]
  minNoticeHours: number
  horizonDays: number
  location: string | null
  pipelineId: string | null
  stageId: string | null
  origin: string
  confirmWhatsapp: boolean
  confirmChannelId: string | null
  active: boolean
  bookings: number
}

export interface SchedulerInput {
  name: string
  headline: string | null
  description: string | null
  userId: string
  durationMinutes: number
  availability: SchedulerWindowInput[]
  minNoticeHours: number
  horizonDays: number
  location: string | null
  pipelineId: string | null
  stageId: string | null
  origin: string
  confirmWhatsapp: boolean
  confirmChannelId: string | null
  active: boolean
}

function schedulerPublicUrl(slug: string): string {
  return `${APP_URL}/agendar/${slug}`
}

const HM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/
function cleanAvailability(input: SchedulerWindowInput[]): SchedulerWindowInput[] {
  const out: SchedulerWindowInput[] = []
  for (let i = 0; i < 7; i++) {
    const w = input?.[i]
    const open = w?.open && HM_RE.test(w.open) ? w.open : null
    const close = w?.close && HM_RE.test(w.close) ? w.close : null
    out.push(open && close ? { open, close } : { open: null, close: null })
  }
  return out
}

/** Membros da conta (dono da agenda). */
export async function listCaptureMembers(): Promise<
  { id: string; name: string }[]
> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({ id: member.userId, name: user.name, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, ctx.accountId))
  return rows.map((r) => ({ id: r.id, name: r.name || r.email }))
}

export async function listSchedulers(): Promise<SchedulerRow[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: schedulers.id,
      name: schedulers.name,
      slug: schedulers.slug,
      active: schedulers.active,
      bookings: schedulers.bookings,
      ownerName: user.name,
    })
    .from(schedulers)
    .leftJoin(user, eq(user.id, schedulers.userId))
    .where(eq(schedulers.accountId, ctx.accountId))
    .orderBy(desc(schedulers.createdAt))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    publicUrl: schedulerPublicUrl(r.slug),
    ownerName: r.ownerName ?? null,
    active: r.active,
    bookings: r.bookings,
  }))
}

export async function getScheduler(id: string): Promise<SchedulerDetail | null> {
  const ctx = await getCurrentAccount()
  const row = firstOrNull(
    await db
      .select()
      .from(schedulers)
      .where(and(eq(schedulers.id, id), eq(schedulers.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    publicUrl: schedulerPublicUrl(row.slug),
    headline: row.headline,
    description: row.description,
    userId: row.userId,
    durationMinutes: row.durationMinutes,
    availability: cleanAvailability(
      (row.availability as SchedulerWindowInput[]) ?? [],
    ),
    minNoticeHours: row.minNoticeHours,
    horizonDays: row.horizonDays,
    location: row.location,
    pipelineId: row.pipelineId,
    stageId: row.stageId,
    origin: row.origin,
    confirmWhatsapp: row.confirmWhatsapp,
    confirmChannelId: row.confirmChannelId,
    active: row.active,
    bookings: row.bookings,
  }
}

async function uniqueSchedulerSlug(name: string): Promise<string> {
  const base = slugifyName(name) || 'agenda'
  for (let i = 0; i < 6; i++) {
    const suffix = Math.random().toString(36).slice(2, 7)
    const slug = `${base}-${suffix}`
    const taken = firstOrNull(
      await db
        .select({ id: schedulers.id })
        .from(schedulers)
        .where(eq(schedulers.slug, slug))
        .limit(1),
    )
    if (!taken) return slug
  }
  return `${base}-${Date.now().toString(36)}`
}

function cleanSchedulerInput(input: SchedulerInput) {
  return {
    name: (input.name ?? '').trim(),
    headline: (input.headline ?? '').trim() || null,
    description: (input.description ?? '').trim() || null,
    userId: input.userId,
    durationMinutes: Math.min(240, Math.max(10, Math.trunc(Number(input.durationMinutes)) || 30)),
    availability: cleanAvailability(input.availability ?? []),
    minNoticeHours: Math.min(168, Math.max(0, Math.trunc(Number(input.minNoticeHours)) || 0)),
    horizonDays: Math.min(60, Math.max(1, Math.trunc(Number(input.horizonDays)) || 14)),
    location: (input.location ?? '').trim() || null,
    pipelineId: input.pipelineId || null,
    stageId: input.stageId || null,
    origin: (input.origin ?? '').trim() || 'Agendamento',
    confirmWhatsapp: !!input.confirmWhatsapp,
    confirmChannelId: input.confirmChannelId || null,
    active: input.active ?? true,
  }
}

export async function createScheduler(
  input: SchedulerInput,
): Promise<{ id: string | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const clean = cleanSchedulerInput(input)
    if (!clean.name) return { id: null, error: 'Dê um nome à página.' }
    if (!clean.userId) return { id: null, error: 'Escolha o dono da agenda.' }
    if (!clean.availability.some((w) => w.open && w.close)) {
      return { id: null, error: 'Defina ao menos um dia com horário disponível.' }
    }
    const slug = await uniqueSchedulerSlug(clean.name)
    const row = await db
      .insert(schedulers)
      .values({ accountId: ctx.accountId, slug, ...clean, createdBy: ctx.userId })
      .returning({ id: schedulers.id })
    return { id: row[0]?.id ?? null, error: null }
  } catch (err) {
    console.error('[createScheduler]', err)
    return { id: null, error: 'Falha ao criar a página de agendamento.' }
  }
}

export async function updateScheduler(
  id: string,
  input: SchedulerInput,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const clean = cleanSchedulerInput(input)
    if (!clean.name) return { error: 'Dê um nome à página.' }
    if (!clean.userId) return { error: 'Escolha o dono da agenda.' }
    const owned = firstOrNull(
      await db
        .select({ id: schedulers.id })
        .from(schedulers)
        .where(and(eq(schedulers.id, id), eq(schedulers.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!owned) return { error: 'Página não encontrada.' }
    await db
      .update(schedulers)
      .set({ ...clean, updatedAt: new Date().toISOString() })
      .where(and(eq(schedulers.id, id), eq(schedulers.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    console.error('[updateScheduler]', err)
    return { error: 'Falha ao salvar a página de agendamento.' }
  }
}

export async function deleteScheduler(
  id: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .delete(schedulers)
      .where(and(eq(schedulers.id, id), eq(schedulers.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    console.error('[deleteScheduler]', err)
    return { error: 'Falha ao excluir a página.' }
  }
}
