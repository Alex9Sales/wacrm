// ============================================================
// 💬 Landing que Conversa — chat público com a IA da conta no lugar do
// formulário. Stateless: o cliente manda o histórico (com teto) a cada turno.
// A IA responde dúvidas sobre o negócio (perfil + catálogo) e captura o lead
// NA CONVERSA: quando tem nome + WhatsApp com DDD, emite o marcador
// [[LEAD: nome | telefone]] no fim da resposta — o servidor tira o marcador,
// valida o DDD e chama o ingestLead (origem "Chat: <nome do form>").
// Anti-abuso: honeypot + teto de 20 turnos + teto de tamanho por mensagem.
// Custo roda na chave de IA da própria conta (usage source 'capture').
// ============================================================
import { NextResponse, after } from 'next/server'
import { checkRateLimit, clientIp, rateLimitResponse } from '@/lib/rate-limit';
import { and, eq } from 'drizzle-orm'

import { db, member, products } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { ingestLead } from '@/lib/leads/ingest'
import { getPublicCaptureForm, getPublicCaptureWaHref } from '@/lib/capture/public'
import { enrollContactInCadence } from '@/lib/cadences/cadence'
import { sendCaptureAiIntro } from '@/lib/capture/ai-intro'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { getCompanyProfile } from '@/lib/ai/company-profile'
import type { ChatMessage } from '@/lib/ai/types'

export const dynamic = 'force-dynamic'

const MAX_TURNS = 20
const MAX_LEN = 600
const LEAD_MARKER = /\[\[\s*LEAD\s*:([^\]]+)\]\]/i

export async function POST(req: Request) {
  // 🛡️ Rate limit por IP (rota pública, auditoria 02/09).
  const rl = await checkRateLimit(`public:capture-chat:${clientIp(req)}`, { limit: 30, windowMs: 60_000 });
  if (!rl.success) return rateLimitResponse(rl);

  try {
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (!body) return NextResponse.json({ ok: false }, { status: 400 })

    // Honeypot: bot preencheu o campo escondido → finge resposta, não gasta IA.
    if (typeof body.site === 'string' && body.site.trim()) {
      return NextResponse.json({ ok: true, reply: 'Certo! 👍', leadCaptured: false })
    }

    const slug = body.slug
    if (typeof slug !== 'string') {
      return NextResponse.json({ ok: false, error: 'Página inválida.' }, { status: 400 })
    }
    const form = await getPublicCaptureForm(slug)
    if (!form || form.content.mode !== 'landing' || !form.content.chat.enabled) {
      return NextResponse.json(
        { ok: false, error: 'Chat indisponível.' },
        { status: 404 },
      )
    }

    const message =
      typeof body.message === 'string' ? body.message.trim().slice(0, MAX_LEN) : ''
    if (!message) {
      return NextResponse.json({ ok: false, error: 'Escreva uma mensagem.' }, { status: 400 })
    }
    const rawHistory = Array.isArray(body.history) ? body.history : []
    if (rawHistory.length > MAX_TURNS * 2) {
      return NextResponse.json(
        { ok: false, error: 'Conversa longa demais — deixe seu WhatsApp que a equipe continua com você.' },
        { status: 400 },
      )
    }
    const history: ChatMessage[] = []
    for (const h of rawHistory) {
      const role = (h as { role?: unknown })?.role
      const content = (h as { content?: unknown })?.content
      if ((role === 'user' || role === 'assistant') && typeof content === 'string') {
        history.push({ role, content: content.slice(0, MAX_LEN) })
      }
    }
    const leadDone = body.leadDone === true

    const config = await loadAiConfig(form.accountId, { requireActive: false })
    if (!config) {
      return NextResponse.json({
        ok: true,
        reply:
          'No momento nosso chat está fora do ar — deixe seu WhatsApp com DDD que a equipe te chama! 😊',
        leadCaptured: false,
      })
    }

    const [profile, prods] = await Promise.all([
      getCompanyProfile(form.accountId),
      db
        .select({ name: products.name, description: products.description })
        .from(products)
        .where(and(eq(products.accountId, form.accountId), eq(products.active, true)))
        .limit(8),
    ])
    const empresa =
      profile.trade_name || profile.business_name || 'a empresa'
    const contexto = [
      `Empresa: ${empresa}`,
      profile.description ? `Sobre: ${profile.description}` : '',
      profile.tone ? `TOM DE VOZ da marca (fale EXATAMENTE neste tom): ${profile.tone}` : '',
      profile.offerings ? `Produtos/serviços: ${profile.offerings}` : '',
      prods.length
        ? `Catálogo: ${prods
            .map((p) => p.name + (p.description ? ` (${p.description})` : ''))
            .join('; ')}`
        : '',
      `Contexto da página: "${form.headline || form.name}"${form.description ? ` — ${form.description}` : ''}`,
    ]
      .filter(Boolean)
      .join('\n')

    const systemPrompt = [
      `Você é o assistente de ${empresa} conversando com um visitante DENTRO da página de captação.`,
      'Responda em português do Brasil, curto (1-3 frases por resposta), simpático e concreto. Nunca invente preço, prazo ou promessa que não esteja nos dados.',
      'Seu objetivo além de ajudar: capturar o contato. Em algum momento NATURAL da conversa (não na primeira resposta, a menos que a pessoa já ofereça), peça o nome e o WhatsApp com DDD pra equipe continuar o atendimento.',
      leadDone
        ? 'O contato JÁ foi capturado nesta conversa — não peça de novo; só continue ajudando.'
        : 'Quando você tiver o NOME e o WHATSAPP COM DDD (10-11 dígitos), termine a resposta com o marcador [[LEAD: nome | telefone]] — em qualquer outra situação, NUNCA escreva esse marcador nem o mencione. Se o telefone vier sem DDD, peça o DDD.',
      'Se perguntarem algo que você não sabe, diga que a equipe responde no WhatsApp — e peça o contato.',
    ].join('\n')

    const result = await generateReply({
      config,
      systemPrompt: `${systemPrompt}\n\nDados do negócio:\n${contexto}`,
      messages: [...history, { role: 'user', content: message }],
      meta: {
        accountId: form.accountId,
        agentId: config.id ?? null,
        channelId: null,
        source: 'capture',
      },
    })

    let reply = result.text.trim()
    let leadCaptured = false
    let waHref: string | null = null

    const match = reply.match(LEAD_MARKER)
    if (match && !leadDone) {
      reply = reply.replace(LEAD_MARKER, '').trim()
      const parts = match[1].split('|').map((s) => s.trim())
      const nome = parts[0] || ''
      const fone = parts[1] || ''
      const digits = fone.replace(/\D/g, '')
      const national = digits.startsWith('55') ? digits.slice(2) : digits
      if (national.length >= 10 && national.length <= 11) {
        // Transcrição resumida → notas do card (o vendedor lê o que rolou).
        const transcript = [...history, { role: 'user', content: message }]
          .slice(-8)
          .map((h) => `${h.role === 'user' ? '👤' : '🤖'} ${h.content}`)
          .join('\n')
        let auditUser = form.createdBy
        if (!auditUser) {
          const m = firstOrNull(
            await db
              .select({ userId: member.userId })
              .from(member)
              .where(eq(member.organizationId, form.accountId))
              .limit(1),
          )
          auditUser = m?.userId ?? null
        }
        if (auditUser) {
          try {
            const lead = await ingestLead(form.accountId, auditUser, {
              rawPhone: fone,
              name: nome || null,
              notes: `💬 Chat da landing "${form.name}":\n${transcript}`,
              pipelineId: form.pipelineId,
              stageId: form.stageId,
              origin: form.origin || 'Landing',
              source: `Chat: ${form.name}`,
              taskSuffix: 'chat da landing',
            })
            leadCaptured = true
            waHref = await getPublicCaptureWaHref(form, 'sent')
            const audit = auditUser
            if (form.cadenceId && lead.contactId) {
              const cadenceId = form.cadenceId
              after(async () => {
                try {
                  await enrollContactInCadence(
                    { accountId: form.accountId, userId: audit },
                    { cadenceId, contactId: lead.contactId, dealId: lead.dealId },
                  )
                } catch (err) {
                  console.error('[capture chat] cadência falhou:', err)
                }
              })
            }
            // ⚡ IA no Segundo Zero (se o dono ligou): leva a conversa pro zap.
            if (form.aiIntro) {
              after(() =>
                sendCaptureAiIntro({
                  accountId: form.accountId,
                  formName: form.name,
                  channelId: form.introChannelId,
                  phone: fone,
                  name: nome || null,
                  company: null,
                  email: null,
                  message: `Conversou no chat da página: ${message.slice(0, 300)}`,
                }),
              )
            }
          } catch (err) {
            console.error('[capture chat] ingestLead falhou:', err)
          }
        }
      } else {
        // Telefone sem DDD: marcador fora e a IA re-pede na sequência.
        reply = `${reply}\n\nSó confirma seu WhatsApp com DDD, por favor? Ex.: (67) 99999-9999 😊`
      }
    } else if (match) {
      reply = reply.replace(LEAD_MARKER, '').trim()
    }

    return NextResponse.json({ ok: true, reply, leadCaptured, waHref })
  } catch (err) {
    console.error('[capture chat]', err)
    return NextResponse.json(
      { ok: false, error: 'Falha no chat. Tente de novo.' },
      { status: 500 },
    )
  }
}
