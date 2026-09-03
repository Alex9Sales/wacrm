import { NextResponse } from 'next/server'

import { getSessionUserId } from '@/lib/auth/session'
import { cleanOrgName, provisionTrialOrg } from '@/lib/auth/trial-provision'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ============================================================
// Provisiona a org de TESTE pro usuário LOGADO. Mantida por compatibilidade
// (abas antigas); o cadastro novo usa /api/trial/signup, que cria login + org
// de uma vez e manda o e-mail de confirmação. Lógica em lib/auth/trial-provision.
// ============================================================

export async function POST(request: Request) {
  const userId = await getSessionUserId().catch(() => null)
  if (!userId) {
    return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 })
  }
  const body = await request.json().catch(() => null)
  try {
    const out = await provisionTrialOrg(userId, cleanOrgName(body?.orgName))
    return NextResponse.json({ ok: true, ...out })
  } catch (err) {
    console.error('[trial/provision] falha:', err)
    return NextResponse.json({ error: 'Não foi possível criar a conta.' }, { status: 500 })
  }
}
