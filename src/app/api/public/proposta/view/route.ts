// Beacon público de VISUALIZAÇÃO da proposta. O cliente abre /proposta/<id> e a
// página bate aqui uma vez (no navegador real) → carimba viewed_at na 1ª vez +
// notifica o vendedor. Sob /api/public (liberado no middleware).
import { NextResponse } from 'next/server'
import { checkRateLimit, clientIp, rateLimitResponse } from '@/lib/rate-limit';

import { markProposalViewed } from '@/lib/proposals/tracking'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  // 🛡️ Rate limit por IP (rota pública, auditoria 02/09).
  const rl = await checkRateLimit(`public:proposta-view:${clientIp(req)}`, { limit: 60, windowMs: 60_000 });
  if (!rl.success) return rateLimitResponse(rl);

  try {
    const body = (await req.json().catch(() => null)) as { id?: unknown } | null
    const id = body?.id
    if (typeof id !== 'string') {
      return NextResponse.json({ ok: false }, { status: 400 })
    }
    await markProposalViewed(id)
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
