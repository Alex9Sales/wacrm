// ============================================================
// POST /api/ai/knowledge/import — importa PERGUNTAS & RESPOSTAS em massa
// pra Base de Conhecimento (pedido do Rafael, 31/08: planilha com 995 Q&As
// não dá pra digitar uma a uma). A UI parseia a planilha (xlsx/csv) no
// navegador e manda os pares aqui em lotes.
//
// Body: { baseId?: string, items: [{ question, answer }] } (máx 200/lote)
// Insere cada par como doc 'qa' e tenta a indexação semântica dentro de um
// orçamento de tempo — o que não indexar continua achável pela busca
// lexical e entra no próximo "Reindexar".
// ============================================================

import { NextResponse } from 'next/server'

import { db, aiKnowledgeDocuments } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument, buildIngestText } from '@/lib/ai/knowledge'
import {
  ensureDefaultBaseId,
  baseBelongsToAccount,
} from '@/lib/ai/knowledge-bases'

const MAX_ITEMS = 200
const INGEST_TIME_BUDGET_MS = 45_000

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = await checkRateLimit(
      `ai-kb-import:${userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as {
      baseId?: unknown
      items?: unknown
    } | null
    const rawItems = Array.isArray(body?.items) ? body.items : null
    if (!rawItems || rawItems.length === 0) {
      return NextResponse.json(
        { error: 'items (pergunta/resposta) são obrigatórios' },
        { status: 400 },
      )
    }
    if (rawItems.length > MAX_ITEMS) {
      return NextResponse.json(
        { error: `Máximo de ${MAX_ITEMS} itens por lote` },
        { status: 400 },
      )
    }
    const items = rawItems
      .map((it) => {
        const o = (it ?? {}) as Record<string, unknown>
        const question =
          typeof o.question === 'string' ? o.question.trim().slice(0, 500) : ''
        const answer =
          typeof o.answer === 'string' ? o.answer.trim().slice(0, 8000) : ''
        return { question, answer }
      })
      .filter((it) => it.question && it.answer)
    if (items.length === 0) {
      return NextResponse.json(
        { error: 'Nenhum par pergunta/resposta válido' },
        { status: 400 },
      )
    }

    const baseIdRaw = typeof body?.baseId === 'string' ? body.baseId : null
    const baseId =
      baseIdRaw && (await baseBelongsToAccount(accountId, baseIdRaw))
        ? baseIdRaw
        : await ensureDefaultBaseId(accountId, userId)

    // 1) Insere TODOS (rápido) — a busca lexical já os enxerga.
    const created: { id: string; question: string; answer: string }[] = []
    for (const it of items) {
      const doc = firstOrNull(
        await db
          .insert(aiKnowledgeDocuments)
          .values({
            accountId,
            knowledgeBaseId: baseId,
            createdBy: userId,
            title: it.question,
            content: it.answer,
            sourceType: 'qa',
            question: it.question,
          })
          .returning({ id: aiKnowledgeDocuments.id }),
      )
      if (doc) created.push({ id: doc.id, ...it })
    }

    // 2) Indexação semântica com orçamento de tempo — o resto fica pro
    //    Reindexar (a UI avisa).
    let indexed = 0
    const { key: embeddingsApiKey } = await loadEmbeddingsKey(accountId)
    const deadline = Date.now() + INGEST_TIME_BUDGET_MS
    for (const doc of created) {
      if (Date.now() > deadline) break
      try {
        await ingestDocument(
          accountId,
          { embeddingsApiKey },
          doc.id,
          buildIngestText('qa', doc.question, doc.answer),
          baseId,
        )
        indexed++
      } catch {
        /* segue — lexical cobre e o Reindexar completa */
      }
    }

    return NextResponse.json({
      success: true,
      created: created.length,
      indexed,
      pending_index: created.length - indexed,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
