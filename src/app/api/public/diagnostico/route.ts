import { NextResponse } from 'next/server'

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
  const segmento = str(body.segmento, 80)
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

  // Monta o bloco de notas do card.
  const lines: string[] = ['📋 Diagnóstico do WhatsApp']
  if (indice != null) lines.push(`Índice de vazamento: ${indice}/100${faixa ? ` (${faixa})` : ''}`)
  if (segmento) lines.push(`Segmento: ${segmento}`)
  if (respostas.length) {
    lines.push('')
    lines.push('Respostas:')
    respostas.forEach((a) => lines.push(`• ${a.pergunta} ${a.resposta ?? '—'}`))
  }
  const notes = lines.join('\n')

  const tags = ['Diagnóstico']
  if (segmento) tags.push(segmento)
  if (faixa) tags.push(faixa)

  try {
    await ingestLead(ACCOUNT_ID, USER_ID, {
      rawPhone: whatsapp,
      name: nome,
      notes,
      pipelineId: PIPELINE_ID,
      stageId: STAGE_ID,
      origin: 'Diagnóstico',
      source: indice != null ? `Diagnóstico (índice ${indice})` : 'Diagnóstico',
      taskSuffix: 'diagnóstico',
      tags,
    })
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
