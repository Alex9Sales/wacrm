import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db, aiConfigs } from '@/db'
import { firstOrNull } from '@/db/helpers'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { readFollowUpConfig } from '@/lib/ai/followup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ============================================================
// Follow-up inteligente (ESCADA) — config POR AGENTE (ai_configs.follow_up).
// Separado do POST grande da config pra não resetar nada. Ao LIGAR, "arma"
// (armedAt=agora) para não disparar no histórico.
//   GET  /api/ai/followup?agent=<id>
//   PATCH /api/ai/followup  { agent, enabled, steps: [{delayValue,delayUnit,instructions}] }  (admin+)
// ============================================================

async function loadAgentFollowUp(accountId: string, agentId: string) {
  return firstOrNull(
    await db
      .select({ id: aiConfigs.id, followUp: aiConfigs.followUp })
      .from(aiConfigs)
      .where(and(eq(aiConfigs.id, agentId), eq(aiConfigs.accountId, accountId)))
      .limit(1),
  )
}

export async function GET(request: Request) {
  try {
    const { accountId } = await getCurrentAccount()
    const agentId = new URL(request.url).searchParams.get('agent')
    if (!agentId) return NextResponse.json({ error: 'agent é obrigatório.' }, { status: 400 })
    const row = await loadAgentFollowUp(accountId, agentId)
    if (!row) return NextResponse.json({ error: 'Agente não encontrado.' }, { status: 404 })
    return NextResponse.json({ followUp: readFollowUpConfig(row.followUp) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request) {
  try {
    const { accountId } = await requireRole('admin')
    const body = await request.json().catch(() => null)
    const agentId = typeof body?.agent === 'string' ? body.agent : ''
    if (!agentId) return NextResponse.json({ error: 'agent é obrigatório.' }, { status: 400 })

    const row = await loadAgentFollowUp(accountId, agentId)
    if (!row) return NextResponse.json({ error: 'Agente não encontrado.' }, { status: 404 })

    const prev = readFollowUpConfig(row.followUp)
    const enabled = body?.enabled === true
    // Arma ao LIGAR (só considera conversas com atividade após isto). Mantém o
    // armedAt se já estava ligado; limpa ao desligar.
    const armedAt = enabled
      ? prev.enabled && prev.armedAt
        ? prev.armedAt
        : new Date().toISOString()
      : null

    const next = readFollowUpConfig({
      enabled,
      steps: Array.isArray(body?.steps) ? body.steps : undefined,
      armedAt,
    })

    await db
      .update(aiConfigs)
      .set({ followUp: next })
      .where(and(eq(aiConfigs.id, agentId), eq(aiConfigs.accountId, accountId)))

    return NextResponse.json({ success: true, followUp: next })
  } catch (err) {
    return toErrorResponse(err)
  }
}
