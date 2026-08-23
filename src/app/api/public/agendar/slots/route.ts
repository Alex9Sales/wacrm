// Slots livres de uma página de agendamento (refresh do cliente quando um
// horário é tomado). Sob /api/public (sem sessão).
import { NextResponse } from 'next/server'

import { getPublicScheduler, computeSlots } from '@/lib/scheduling/public'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const slug = new URL(req.url).searchParams.get('slug') ?? ''
    const scheduler = await getPublicScheduler(slug)
    if (!scheduler) {
      return NextResponse.json({ ok: false }, { status: 404 })
    }
    const days = await computeSlots(scheduler)
    return NextResponse.json({ ok: true, days })
  } catch (err) {
    console.error('[agendar slots]', err)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
