// ============================================================
// Internal claim check for the voice bridge (IA de voz — fatia 6, transbordo).
//
//   GET /api/internal/voice-call-claimed?callId=<gowsCallId>
//
// The bridge (mode=overflow) waits a few rings, then asks here whether a HUMAN
// already picked up the call. Reads call_logs.claimed_by (the same "first to
// answer wins" lock the CRM sets on accept). No row / no claimant → not claimed
// → the AI may take the call. Server-to-server: bearer service token.
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
  if (!callId) return NextResponse.json({ claimed: false })

  const [row] = await db
    .select({ claimedBy: callLogs.claimedBy, status: callLogs.status })
    .from(callLogs)
    .where(eq(callLogs.externalCallId, callId))
    .limit(1)

  // Claimed = a human accepted (claimed_by set) or the row is already answered.
  const claimed = !!row && (!!row.claimedBy || row.status === 'answered')
  return NextResponse.json({ claimed })
}
