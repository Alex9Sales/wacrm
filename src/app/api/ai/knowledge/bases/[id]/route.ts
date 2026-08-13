import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  updateBase,
  deleteBase,
  baseCount,
  baseBelongsToAccount,
} from '@/lib/ai/knowledge-bases'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/** PATCH /api/ai/knowledge/bases/[id] (admin+) — renomeia / edita descrição. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = await checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    if (!(await baseBelongsToAccount(accountId, id))) {
      return NextResponse.json({ error: 'Base não encontrada.' }, { status: 404 })
    }
    const body = await request.json().catch(() => null)
    const name = typeof body?.name === 'string' ? body.name.trim() : undefined
    const description =
      typeof body?.description === 'string' ? body.description : undefined
    if (name === undefined && description === undefined) {
      return NextResponse.json({ error: 'Nada para atualizar.' }, { status: 400 })
    }
    if (name !== undefined && !name) {
      return NextResponse.json({ error: 'O nome não pode ficar vazio.' }, { status: 400 })
    }
    await updateBase(accountId, id, { name, description })
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/knowledge/bases/[id] (admin+) — apaga a base (documentos e
 * chunks caem em cascata). Recusa apagar a ÚLTIMA base da conta.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { accountId } = await requireRole('admin')
    const { id } = await params
    if (!(await baseBelongsToAccount(accountId, id))) {
      return NextResponse.json({ error: 'Base não encontrada.' }, { status: 404 })
    }
    if ((await baseCount(accountId)) <= 1) {
      return NextResponse.json(
        { error: 'Não dá para apagar a única base. Crie outra antes.' },
        { status: 400 },
      )
    }
    await deleteBase(accountId, id)
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
