// ============================================================
// Webhook do RD Station Marketing — o lead converte lá e cai aqui.
//
// O RD não assina o webhook: não manda HMAC, não manda segredo no cabeçalho.
// Então o segredo é a própria URL — um token longo por fonte, guardado em
// `external_account_id` (a chave de roteamento que a tabela já indexa). URL
// errada = 404 seco, sem dizer se a fonte existe.
//
// Responde SEMPRE 200 quando o token confere, mesmo com o corpo estranho: o RD
// desabilita o webhook depois de uma sequência de respostas ruins, e perder o
// funil inteiro por causa de um lead torto é um péssimo negócio. O que não deu
// pra aproveitar vai pro log.
//
// ⚠️ Conversão por IMPORTAÇÃO ou cadastro manual NÃO dispara webhook (está na
// documentação do RD). Quem já está na base tem que ser puxado à parte.
// ============================================================

import { NextResponse, after } from 'next/server'

import { loadLeadSourceForWebhook } from '@/lib/leads/sources'
import { parseRdWebhook, pickIntroForOrigin, rdOriginLabel } from '@/lib/leads/providers/rdstation'
import { buildLeadNotes } from '@/lib/leads/providers/shared'
import { ingestLead } from '@/lib/leads/ingest'
import { extractLeadFacts } from '@/lib/leads/lead-facts'
import { fillDealFactFields } from '@/lib/leads/deal-fact-fields'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { firstNameForGreeting, greeting } from '@/lib/cdl/names'
import { renderForContact } from '@/lib/whatsapp/message-vars'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** O botão "Verificar" do RD só quer saber se o endereço responde. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params
  const source = await loadLeadSourceForWebhook('rdstation', token)
  if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params
  const source = await loadLeadSourceForWebhook('rdstation', token)
  if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    // O RD testa o endereço com corpo vazio. Isso é um "oi", não um erro.
    return NextResponse.json({ ok: true, leads: 0 })
  }

  const leads = parseRdWebhook(body)
  if (!leads.length) return NextResponse.json({ ok: true, leads: 0 })

  // Responde na hora e ingere depois: o RD tem tempo limite e conta resposta
  // lenta como falha. Criar contato + card + primeira mensagem não cabe nele.
  after(async () => {
    const auditUserId = await resolveAuditUserId(source.accountId)
    const templateLanguage =
      typeof source.providerMeta.introTemplateLanguage === 'string'
        ? source.providerMeta.introTemplateLanguage
        : 'pt_BR'

    for (const lead of leads) {
      if (!lead.phone) {
        console.error(`[rd-station] lead sem telefone (fonte ${source.id}) — ignorado`)
        continue
      }
      try {
        const known = [lead.name, lead.phone, lead.email, lead.company]
        const notes = buildLeadNotes(lead.fields, lead.meta, known)
        const origem = rdOriginLabel(lead)
        // Abertura certa pro TIPO de lead (franquia × orçamento × vaga).
        const intro = pickIntroForOrigin(source.providerMeta, origem)
        const result = await ingestLead(source.accountId, auditUserId, {
          rawPhone: lead.phone,
          name: lead.name,
          email: lead.email,
          company: lead.company,
          notes: notes || null,
          tags: ['lead-rdstation'],
          pipelineId: source.pipelineId,
          stageId: source.stageId,
          taskSuffix: 'lead do RD Station',
          fallbackNote: `Lead do RD Station (${origem}).`,
          origin: 'RD Station',
          source: origem,
          // Primeira mensagem: no canal oficial tem que ser template (contato
          // frio = janela fechada). O nome do lead vai como {{1}}.
          introTemplate: source.deliverToAi && intro.templateName
            ? {
                name: intro.templateName,
                language: templateLanguage,
                params: [firstNameForGreeting(lead.name) || 'tudo bem'],
              }
            : null,
          // Texto de abertura (canal sem template, ou template recusado): o
          // da regra/fonte com {{primeiro_nome}}, senão o genérico. Linha
          // "---" separa em mensagens curtas.
          introText: source.deliverToAi
            ? intro.text
              ? renderForContact(intro.text, { name: lead.name })
              : introTextOf(lead.name)
            : null,
          // Número da abertura: o da REGRA desse tipo de lead, senão o da fonte.
          channelId:
            intro.channelId ??
            (typeof source.providerMeta.introChannelId === 'string'
              ? source.providerMeta.introChannelId
              : null),
          // Agente dono da conversa de abertura — a IA atende o lead mesmo num
          // número que não é dela (ver IngestLeadInput.aiAgentId).
          aiAgentId:
            source.deliverToAi && typeof source.providerMeta.introAgentId === 'string'
              ? source.providerMeta.introAgentId
              : null,
        })
        // Cidade/Estado/Investimento/Campanha nos CAMPOS do card (só os que a
        // conta criou) — Renato 18/09: "no card não aparece investimento nem
        // cidade". Conversão nova do mesmo lead atualiza com o dado mais novo.
        if (result.dealId) {
          const facts = extractLeadFacts([
            ...Object.entries(lead.meta),
            ...Object.entries(lead.fields),
          ])
          await fillDealFactFields(source.accountId, result.dealId, facts)
        }
      } catch (err) {
        console.error('[rd-station] falha ao ingerir lead:', err)
      }
    }
  })

  return NextResponse.json({ ok: true, leads: leads.length })
}

/** Texto de abertura pros canais sem template (WAHA). */
function introTextOf(name: string | null): string {
  return `${greeting(name)} Recebemos o seu contato. Como posso te ajudar?`
}
