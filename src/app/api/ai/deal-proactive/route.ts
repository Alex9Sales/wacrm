import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db, aiConfigs } from '@/db'
import { firstOrNull } from '@/db/helpers'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { getDefaultAgentId } from '@/lib/ai/agents'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ============================================================
// IA proativa em Negociações — controle SEPARADO da config de chat do agente
// (Alex: "tira dali pra não misturar"). O flag mora no agente DEFAULT
// (ai_configs.deal_suggestions_proactive); aqui a gente só lê/liga sem tocar
// no resto da configuração.
// ============================================================

/** GET /api/ai/deal-proactive — estado atual (qualquer membro). */
export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    const agentId = await getDefaultAgentId(accountId)
    if (!agentId) return NextResponse.json({ enabled: false, configured: false })
    const row = firstOrNull(
      await db
        .select({ enabled: aiConfigs.dealSuggestionsProactive })
        .from(aiConfigs)
        .where(eq(aiConfigs.id, agentId))
        .limit(1),
    )
    return NextResponse.json({ enabled: !!row?.enabled, configured: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** PATCH /api/ai/deal-proactive (admin+) — liga/desliga no agente default. */
export async function PATCH(request: Request) {
  try {
    const { accountId } = await requireRole('admin')
    const agentId = await getDefaultAgentId(accountId)
    if (!agentId) {
      return NextResponse.json(
        { error: 'Configure um agente primeiro.' },
        { status: 400 },
      )
    }
    const body = await request.json().catch(() => null)
    const enabled = body?.enabled === true
    await db
      .update(aiConfigs)
      .set({ dealSuggestionsProactive: enabled })
      .where(eq(aiConfigs.id, agentId))
    return NextResponse.json({ success: true, enabled })
  } catch (err) {
    return toErrorResponse(err)
  }
}
