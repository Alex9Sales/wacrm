// Reserva pública de um horário. Valida (honeypot + nome + WhatsApp com DDD),
// e delega pro núcleo (evento + lead + confirmação). Sob /api/public.
import { NextResponse } from 'next/server'
import { checkRateLimit, clientIp, rateLimitResponse } from '@/lib/rate-limit';

import { getPublicScheduler, bookSlot } from '@/lib/scheduling/public'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  // 🛡️ Rate limit por IP (rota pública, auditoria 02/09).
  const rl = await checkRateLimit(`public:agendar-book:${clientIp(req)}`, { limit: 10, windowMs: 60_000 });
  if (!rl.success) return rateLimitResponse(rl);

  try {
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (!body) return NextResponse.json({ ok: false }, { status: 400 })

    // Honeypot anti-bot (mesmo padrão da captação).
    if (typeof body.site === 'string' && body.site.trim()) {
      return NextResponse.json({ ok: true, whenLabel: '' })
    }

    const s = (k: string) =>
      typeof body[k] === 'string' ? (body[k] as string).trim() : ''
    const slug = s('slug')
    const startIso = s('startIso')
    const nome = s('nome')
    const phone = s('telefone')
    if (!slug || !startIso) {
      return NextResponse.json({ ok: false, error: 'Dados inválidos.' }, { status: 400 })
    }
    if (!nome) {
      return NextResponse.json({ ok: false, error: 'Informe seu nome.' }, { status: 400 })
    }
    const telDigits = phone.replace(/\D/g, '')
    const national = telDigits.startsWith('55') ? telDigits.slice(2) : telDigits
    if (national.length < 10 || national.length > 11) {
      return NextResponse.json(
        { ok: false, error: 'Informe o WhatsApp com DDD — ex.: (67) 99999-9999' },
        { status: 400 },
      )
    }

    const scheduler = await getPublicScheduler(slug)
    if (!scheduler) {
      return NextResponse.json(
        { ok: false, error: 'Página de agendamento indisponível.' },
        { status: 404 },
      )
    }

    const res = await bookSlot(scheduler, {
      startIso,
      nome,
      phone,
      email: s('email') || null,
      obs: s('obs') || null,
    })
    return NextResponse.json(res, { status: res.ok ? 200 : res.slotTaken ? 409 : 400 })
  } catch (err) {
    console.error('[agendar book]', err)
    return NextResponse.json({ ok: false, error: 'Falha ao agendar.' }, { status: 500 })
  }
}
