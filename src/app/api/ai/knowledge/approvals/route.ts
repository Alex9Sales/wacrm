import { NextResponse } from 'next/server'

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  listPendingApprovals,
  approveApproval,
  rejectApproval,
} from '@/lib/ai/knowledge-approvals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ============================================================
// Fase K4 — Fila de aprovação. GET lista as sugestões pendentes; POST aprova
// (vira Q&A na base) ou rejeita. Aprovar/rejeitar = admin+.
// ============================================================

/** GET /api/ai/knowledge/approvals — sugestões pendentes. */
export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    const items = await listPendingApprovals(accountId)
    return NextResponse.json({ items })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/knowledge/approvals (admin+)
 *   { id, action: 'approve' | 'reject', question?, answer?, baseId? }
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = await checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const id = typeof body?.id === 'string' ? body.id : ''
    const action = body?.action
    if (!id || (action !== 'approve' && action !== 'reject')) {
      return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 })
    }

    if (action === 'reject') {
      const ok = await rejectApproval(accountId, id, userId)
      if (!ok) return NextResponse.json({ error: 'Sugestão não encontrada.' }, { status: 404 })
      return NextResponse.json({ success: true })
    }

    const res = await approveApproval(
      accountId,
      id,
      {
        question: typeof body?.question === 'string' ? body.question : undefined,
        answer: typeof body?.answer === 'string' ? body.answer : undefined,
        baseId: typeof body?.baseId === 'string' ? body.baseId : undefined,
      },
      userId,
    )
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 })
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
