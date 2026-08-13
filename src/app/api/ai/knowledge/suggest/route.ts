import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { suggestFromConversation } from '@/lib/ai/knowledge-approvals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ============================================================
// Fase K4 — A IA analisa uma conversa e PROPÕE Q&A (fila de aprovação).
//   POST /api/ai/knowledge/suggest  { conversationId }  (admin+)
// ============================================================

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = await checkRateLimit(
      `ai-kb-suggest:${userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const conversationId =
      typeof body?.conversationId === 'string' ? body.conversationId : ''
    if (!conversationId) {
      return NextResponse.json({ error: 'Escolha uma conversa.' }, { status: 400 })
    }

    const res = await suggestFromConversation(accountId, conversationId, userId)
    if (res.error) return NextResponse.json({ error: res.error }, { status: 400 })
    return NextResponse.json({ success: true, created: res.created })
  } catch (err) {
    return toErrorResponse(err)
  }
}
