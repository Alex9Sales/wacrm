import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { canEditSettings } from '@/lib/auth/roles'
import { getUsageDashboard, type UsageSource } from '@/lib/ai/analytics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ============================================================
// Fase B — Painel "Uso de LLM". Agrega `ai_usage` (custo derivado local).
// Custo é sensível → só supervisor+ (canEditSettings).
//   GET /api/ai/usage?days=30&source=real|playground|all[&agent=<id>]
// ============================================================

export async function GET(request: Request) {
  try {
    const { accountId, role } = await getCurrentAccount()
    if (!canEditSettings(role)) {
      return NextResponse.json({ error: 'Sem permissão.' }, { status: 403 })
    }

    const url = new URL(request.url)
    const days = Number(url.searchParams.get('days')) || 30
    const rawSource = url.searchParams.get('source')
    const source: UsageSource =
      rawSource === 'playground' || rawSource === 'all' ? rawSource : 'real'
    const agentId = url.searchParams.get('agent')

    const data = await getUsageDashboard(accountId, { days, source, agentId })
    return NextResponse.json(data)
  } catch (err) {
    return toErrorResponse(err)
  }
}
