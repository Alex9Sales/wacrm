// GET /api/google/calendar/connect — inicia o OAuth do Google Calendar.
// Exige sessão (associa a conexão ao usuário no callback). Redireciona
// pro consent do Google. Credenciais vêm do ambiente.

import { NextResponse } from 'next/server'
import { getCurrentAccount } from '@/lib/auth/account'
import { googleConfigured, buildAuthUrl, signState } from '@/lib/google/calendar'

export async function GET() {
  const base = (process.env.BETTER_AUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  try {
    await getCurrentAccount()
  } catch {
    return NextResponse.redirect(`${base}/login`)
  }
  if (!googleConfigured()) {
    return NextResponse.redirect(`${base}/agenda?google=error&reason=nao_configurado`)
  }
  return NextResponse.redirect(buildAuthUrl(signState()))
}
