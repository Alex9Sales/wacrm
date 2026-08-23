// ============================================================
// Quiz com IA — o RESULTADO. A IA da conta (que já conhece o negócio: perfil
// da empresa + catálogo) lê as respostas do lead e devolve:
//   1. `result` — diagnóstico personalizado mostrado NA TELA pro lead;
//   2. `qualification` — quente/morno/frio (vira etiqueta no contato);
//   3. `sellerSummary` — 1-2 frases pro vendedor (vai pro histórico do card).
// Best-effort: qualquer falha → null e o chamador usa o texto de fallback.
// Sem 'server-only' (usada só pela rota pública de submissão).
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, products } from '@/db'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { getCompanyProfile } from '@/lib/ai/company-profile'

export interface QuizAnswer {
  question: string
  answer: string
}

export type QuizQualification = 'quente' | 'morno' | 'frio'

export interface QuizAiOutcome {
  result: string
  qualification: QuizQualification | null
  sellerSummary: string | null
}

export async function generateQuizResult(opts: {
  accountId: string
  quizName: string
  resultPrompt: string | null
  answers: QuizAnswer[]
  leadName: string | null
}): Promise<QuizAiOutcome | null> {
  try {
    const config = await loadAiConfig(opts.accountId, { requireActive: false })
    if (!config) return null

    const [profile, prods] = await Promise.all([
      getCompanyProfile(opts.accountId),
      db
        .select({ name: products.name, description: products.description })
        .from(products)
        .where(and(eq(products.accountId, opts.accountId), eq(products.active, true)))
        .limit(8),
    ])

    const empresa =
      profile.trade_name || profile.business_name || '(nome não informado)'
    const contexto = [
      `Empresa: ${empresa}`,
      profile.description ? `Sobre: ${profile.description}` : '',
      profile.tone
        ? `TOM DE VOZ da marca (escreva EXATAMENTE neste tom): ${profile.tone}`
        : '',
      profile.offerings ? `Produtos/serviços: ${profile.offerings}` : '',
      prods.length
        ? `Catálogo: ${prods
            .map((p) => p.name + (p.description ? ` (${p.description})` : ''))
            .join('; ')}`
        : '',
      opts.resultPrompt
        ? `Instruções do dono pra este quiz: ${opts.resultPrompt}`
        : '',
    ]
      .filter(Boolean)
      .join('\n')

    const respostas = opts.answers
      .map((a, i) => `${i + 1}. ${a.question}\n   → ${a.answer}`)
      .join('\n')

    const systemPrompt = [
      'Você é o consultor especialista da empresa abaixo. Um possível cliente acabou de responder um quiz e vai LER seu diagnóstico na tela.',
      'Escreva em português do Brasil, direto e concreto, falando com "você". Sem clichê de marketing e sem inventar dados, números ou promessas.',
      'O diagnóstico deve: citar o que a pessoa respondeu, mostrar que você entendeu a situação dela, dar 1-2 recomendações práticas e terminar puxando pro próximo passo (a equipe chama no WhatsApp).',
      'Responda APENAS com um JSON válido, sem comentários e sem markdown, neste formato exato:',
      '{"resultado": "...", "qualificacao": "quente|morno|frio", "resumo_vendedor": "..."}',
      'Regras: resultado com 3-6 frases (pode 1-2 emojis, sem títulos/markdown); qualificacao = potencial de compra AGORA (quente = dor clara + urgência; morno = interesse sem pressa; frio = só curiosidade); resumo_vendedor = 1-2 frases objetivas pro vendedor saber como abordar.',
    ].join('\n')

    const result = await generateReply({
      config,
      systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Dados do negócio:\n${contexto}\n\nQuiz: "${opts.quizName}"\nLead: ${opts.leadName || '(sem nome)'}\nRespostas:\n${respostas}\n\nGere o JSON do diagnóstico.`,
        },
      ],
      meta: {
        accountId: opts.accountId,
        agentId: config.id ?? null,
        channelId: null,
        source: 'capture',
      },
    })

    // Parse robusto: tira cerca de código e pega o primeiro objeto JSON.
    const raw = result.text.replace(/```(?:json)?/gi, '').trim()
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      resultado?: unknown
      qualificacao?: unknown
      resumo_vendedor?: unknown
    }
    const text =
      typeof parsed.resultado === 'string' ? parsed.resultado.trim().slice(0, 2000) : ''
    if (!text) return null
    const qRaw =
      typeof parsed.qualificacao === 'string'
        ? parsed.qualificacao.trim().toLowerCase()
        : ''
    const qualification: QuizQualification | null =
      qRaw === 'quente' || qRaw === 'morno' || qRaw === 'frio' ? qRaw : null
    const sellerSummary =
      typeof parsed.resumo_vendedor === 'string'
        ? parsed.resumo_vendedor.trim().slice(0, 600) || null
        : null
    return { result: text, qualification, sellerSummary }
  } catch (err) {
    console.error('[generateQuizResult]', err)
    return null
  }
}
