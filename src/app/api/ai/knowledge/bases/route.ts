import { NextResponse } from 'next/server'

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { listBases, createBase } from '@/lib/ai/knowledge-bases'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ============================================================
// Fase K — Bases de conhecimento (nível conta). GET lista (qualquer membro);
// POST cria (admin+). Documentos vivem em /api/ai/knowledge?baseId=.
// ============================================================

/** GET /api/ai/knowledge/bases — bases da conta + contagem de documentos. */
export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    const bases = await listBases(accountId)
    return NextResponse.json({ bases })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** POST /api/ai/knowledge/bases (admin+) — cria uma base. */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = await checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name) {
      return NextResponse.json({ error: 'Nome é obrigatório.' }, { status: 400 })
    }
    const description =
      typeof body?.description === 'string' ? body.description : null
    const base = await createBase(accountId, userId, name, description)
    return NextResponse.json({ id: base.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
