// Slots livres de uma página de agendamento (refresh do cliente quando um
// horário é tomado). Sob /api/public (sem sessão).
import { NextResponse } from 'next/server'
import { checkRateLimit, clientIp, rateLimitResponse } from '@/lib/rate-limit';

import { getPublicScheduler, computeSlots } from '@/lib/scheduling/public'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  // 🛡️ Rate limit por IP (rota pública, auditoria 02/09).
  const rl = await checkRateLimit(`public:agendar-slots:${clientIp(req)}`, { limit: 60, windowMs: 60_000 });
  if (!rl.success) return rateLimitResponse(rl);

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
