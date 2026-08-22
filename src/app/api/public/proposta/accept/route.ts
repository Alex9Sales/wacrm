// Aceite público da proposta. O cliente clica "Aceitar", informa nome (+ CPF/CNPJ
// opcional) → carimba accepted_at + aceitante + IP, notifica o vendedor e joga na
// timeline do negócio. Sob /api/public (liberado no middleware).
import { NextResponse } from 'next/server'

import { acceptProposal } from '@/lib/proposals/tracking'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as {
      id?: unknown
      name?: unknown
      document?: unknown
    } | null
    const id = body?.id
    const name = body?.name
    if (typeof id !== 'string' || typeof name !== 'string') {
      return NextResponse.json({ ok: false, error: 'Dados inválidos.' }, { status: 400 })
    }
    const ip =
      (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
      req.headers.get('x-real-ip') ||
      null
    const res = await acceptProposal(id, {
      name,
      document: typeof body?.document === 'string' ? body.document : null,
      ip,
    })
    return NextResponse.json(res, { status: res.ok ? 200 : 400 })
  } catch {
    return NextResponse.json({ ok: false, error: 'Erro ao registrar o aceite.' }, { status: 500 })
  }
}
