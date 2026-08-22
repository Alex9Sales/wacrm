import { NextResponse } from 'next/server'

import { db, dealCustomValues, dealEvents } from '@/db'
import { ingestLead, LeadPhoneError } from '@/lib/leads/ingest'

// Endpoint PÚBLICO (sem auth) do formulário /diagnostico. Recebe o quiz e joga
// o lead no funil "FluxiaCRM" > "Novo lead" da conta da Fluxia, com origem
// "Diagnóstico" e as respostas nas notas do card. Single-tenant de propósito
// (é o diagnóstico da própria Fluxia). Proteções: honeypot + validação básica.
//
// Ids configuráveis por env (fallback nos ids reais da conta Fluxia).
const ACCOUNT_ID = process.env.DIAGNOSTICO_ACCOUNT_ID || '310ed185-53fc-414d-be6f-28cecf3dcc58'
const USER_ID = process.env.DIAGNOSTICO_USER_ID || 'e9a94ff1-4d57-44a3-b538-1b62d265c3d4'
const PIPELINE_ID = process.env.DIAGNOSTICO_PIPELINE_ID || '23a7223f-e4d6-49a6-9c05-b4e95791a216'
const STAGE_ID = process.env.DIAGNOSTICO_STAGE_ID || 'e011004b-8324-419c-90a4-add507c4b8ef'
// Campos personalizados do negócio (entity='deal') que o diagnóstico preenche.
const FIELD_INDICE = process.env.DIAGNOSTICO_FIELD_INDICE || 'a8183611-637e-4bd5-ae99-ec4e5ee2eacc'
const FIELD_SEGMENTO = process.env.DIAGNOSTICO_FIELD_SEGMENTO || '7d8f3eb2-690b-4495-b916-cd80336a4999'
const FIELD_FATURAMENTO = process.env.DIAGNOSTICO_FIELD_FATURAMENTO || '8f9d93b8-391b-4985-bae1-375109d26d1c'
const FIELD_FUNCIONARIOS = process.env.DIAGNOSTICO_FIELD_FUNCIONARIOS || 'd259a4a5-eda5-44b0-b1f8-d759fccf3c21'
const FIELD_DOC = process.env.DIAGNOSTICO_FIELD_DOC || '251ff044-a69c-472f-b036-94d7bb245417'

export const dynamic = 'force-dynamic'

function str(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

interface Answer {
  pergunta: string
  resposta: string | null
}

export async function POST(req: Request) {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'Body inválido.' }, { status: 400 })
  }

  // Honeypot: bots preenchem o campo escondido "site". Finge sucesso e ignora.
  if (str(body.site)) {
    return NextResponse.json({ ok: true })
  }

  const nome = str(body.nome, 120)
  const whatsapp = str(body.whatsapp, 30).replace(/[^0-9]/g, '')
  const email = str(body.email, 160)
  const empresa = str(body.empresa, 120)
  const documento = str(body.documento, 30)
  const segmento = str(body.segmento, 80)
  const faturamento = str(body.faturamento, 40)
  const funcionarios = str(body.funcionarios, 40)
  const indice = Number.isFinite(Number(body.indice))
    ? Math.max(0, Math.min(100, Math.round(Number(body.indice))))
    : null
  const faixa = str(body.faixa, 40)

  if (nome.length < 2) {
    return NextResponse.json({ ok: false, error: 'Nome inválido.' }, { status: 400 })
  }
  if (whatsapp.length < 10 || whatsapp.length > 13) {
    return NextResponse.json({ ok: false, error: 'WhatsApp inválido.' }, { status: 400 })
  }

  const respostas: Answer[] = Array.isArray(body.respostas)
    ? (body.respostas as unknown[])
        .slice(0, 20)
        .map((r) => {
          const o = (r ?? {}) as Record<string, unknown>
          return { pergunta: str(o.pergunta, 160), resposta: str(o.resposta, 160) || null }
        })
        .filter((a) => a.pergunta)
    : []

  // Resumo curto pro campo Observações do card.
  const shortNote =
    `Diagnóstico do WhatsApp · índice ${indice ?? '—'}/100` +
    (faixa ? ` (${faixa})` : '') +
    (segmento ? ` · ${segmento}` : '')

  // Bloco completo (com todas as respostas) pro Histórico do negócio.
  const lines: string[] = ['📋 Diagnóstico do WhatsApp']
  if (indice != null) lines.push(`Índice de vazamento: ${indice}/100${faixa ? ` (${faixa})` : ''}`)
  if (empresa) lines.push(`Empresa: ${empresa}`)
  if (documento) lines.push(`CNPJ/CPF: ${documento}`)
  if (segmento) lines.push(`Segmento: ${segmento}`)
  if (faturamento) lines.push(`Faturamento (mês): ${faturamento}`)
  if (funcionarios) lines.push(`Funcionários: ${funcionarios}`)
  if (email) lines.push(`E-mail: ${email}`)
  if (respostas.length) {
    lines.push('')
    lines.push('Respostas:')
    respostas.forEach((a) => lines.push(`• ${a.pergunta} ${a.resposta ?? '—'}`))
  }
  const fullNote = lines.join('\n')

  const tags = ['Diagnóstico']
  if (segmento) tags.push(segmento)
  if (faixa) tags.push(faixa)

  try {
    const res = await ingestLead(ACCOUNT_ID, USER_ID, {
      rawPhone: whatsapp,
      name: nome,
      email: email || null,
      company: empresa || null,
      notes: shortNote,
      pipelineId: PIPELINE_ID,
      stageId: STAGE_ID,
      origin: 'Diagnóstico',
      source: indice != null ? `Diagnóstico (índice ${indice})` : 'Diagnóstico',
      taskSuffix: 'diagnóstico',
      tags,
    })
    // Joga o diagnóstico completo no Histórico do negócio (aparece na timeline
    // "anotações", não só no campo Observações).
    if (res.dealId) {
      try {
        await db.insert(dealEvents).values({
          accountId: ACCOUNT_ID,
          dealId: res.dealId,
          actorUserId: USER_ID,
          type: 'note',
          data: { text: fullNote },
        })
      } catch (e) {
        console.error('[diagnostico] deal_event note failed:', e)
      }
      // Campos personalizados do negócio: Índice de vazamento + Segmento.
      try {
        const cv: {
          accountId: string
          dealId: string
          customFieldId: string
          value: string
        }[] = []
        if (indice != null)
          cv.push({ accountId: ACCOUNT_ID, dealId: res.dealId, customFieldId: FIELD_INDICE, value: String(indice) })
        if (segmento)
          cv.push({ accountId: ACCOUNT_ID, dealId: res.dealId, customFieldId: FIELD_SEGMENTO, value: segmento })
        if (faturamento)
          cv.push({ accountId: ACCOUNT_ID, dealId: res.dealId, customFieldId: FIELD_FATURAMENTO, value: faturamento })
        if (funcionarios)
          cv.push({ accountId: ACCOUNT_ID, dealId: res.dealId, customFieldId: FIELD_FUNCIONARIOS, value: funcionarios })
        if (documento)
          cv.push({ accountId: ACCOUNT_ID, dealId: res.dealId, customFieldId: FIELD_DOC, value: documento })
        if (cv.length) await db.insert(dealCustomValues).values(cv)
      } catch (e) {
        console.error('[diagnostico] deal_custom_values failed:', e)
      }
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof LeadPhoneError) {
      return NextResponse.json({ ok: false, error: 'Telefone inválido.' }, { status: 400 })
    }
    console.error('[diagnostico] ingest failed:', err)
    // Não trava o usuário: o resultado dele aparece de qualquer forma no front.
    return NextResponse.json({ ok: false, error: 'Falha ao registrar.' }, { status: 500 })
  }
}
