// ============================================================
// Internal handoff check for the voice bridge (IA de voz — fatia 5B).
//
//   GET /api/internal/voice-handoff?callId=<gowsCallId>
//
// While the AI is on an ACTIVE call, the bridge polls this to learn whether a
// HUMAN clicked "Assumir" and took the call over. The signal is
// `call_logs.claimed_by` becoming a real user id: the AI itself never writes
// `claimed_by` (only `status='answered'`), so a non-null `claimed_by` on an
// AI call unambiguously means a human took over — distinct from the
// overflow check (voice-call-claimed), which also treats `status='answered'`
// as claimed and would therefore see the AI's OWN answered call as "claimed".
// On a truthy result the bridge speaks a short handoff line, then releases its
// gows audio leg WITHOUT ending the call, leaving the human's leg live.
// Server-to-server: bearer service token.
// ============================================================

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db, callLogs } from '@/db'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const token = process.env.VOICE_BRIDGE_TOKEN
  if (!token || request.headers.get('authorization') !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const callId = new URL(request.url).searchParams.get('callId') ?? ''
  if (!callId) return NextResponse.json({ handoff: false })

  const [row] = await db
    .select({ claimedBy: callLogs.claimedBy })
    .from(callLogs)
    .where(eq(callLogs.externalCallId, callId))
    .limit(1)

  // A human took over iff claimed_by is set (the AI never writes it).
  return NextResponse.json({ handoff: !!row?.claimedBy })
}
