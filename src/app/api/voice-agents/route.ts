// ============================================================
// Voice agent config per channel (IA de voz — fatia 1).
//
//   GET  /api/voice-agents          — every voice-capable (waha) channel of the
//                                      account with its voice-agent config.
//   PUT  /api/voice-agents          — upsert one channel's config
//                                      { channelId, enabled, mode, systemPrompt,
//                                        voiceId, greeting }.
//
// Admin-gated (it's channel/agent configuration). The media bridge reads these
// rows to decide, per number, whether the AI answers and with which persona.
// ============================================================

import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db, channels, voiceAgents } from '@/db'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

const MODES = new Set(['always', 'overflow'])

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    // Only the non-official (waha) channels can carry voice today.
    const rows = await db
      .select({
        channelId: channels.id,
        channelName: channels.name,
        provider: channels.provider,
        phoneNumber: channels.phoneNumber,
        enabled: voiceAgents.enabled,
        mode: voiceAgents.mode,
        systemPrompt: voiceAgents.systemPrompt,
        voiceId: voiceAgents.voiceId,
        greeting: voiceAgents.greeting,
      })
      .from(channels)
      .leftJoin(voiceAgents, eq(voiceAgents.channelId, channels.id))
      .where(
        and(eq(channels.accountId, ctx.accountId), eq(channels.provider, 'waha')),
      )
    return NextResponse.json({
      agents: rows.map((r) => ({
        channelId: r.channelId,
        channelName: r.channelName,
        phoneNumber: r.phoneNumber,
        enabled: r.enabled ?? false,
        mode: r.mode ?? 'overflow',
        systemPrompt: r.systemPrompt ?? '',
        voiceId: r.voiceId ?? '',
        greeting: r.greeting ?? '',
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => ({}))) as {
      channelId?: unknown
      enabled?: unknown
      mode?: unknown
      systemPrompt?: unknown
      voiceId?: unknown
      greeting?: unknown
    }
    const channelId = typeof body.channelId === 'string' ? body.channelId : ''
    if (!channelId) {
      return NextResponse.json({ error: 'channelId required' }, { status: 400 })
    }
    // The channel must belong to this account (tenant guard).
    const [channel] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.accountId, ctx.accountId)))
      .limit(1)
    if (!channel) {
      return NextResponse.json({ error: 'Canal não encontrado.' }, { status: 404 })
    }

    const mode =
      typeof body.mode === 'string' && MODES.has(body.mode)
        ? body.mode
        : 'overflow'
    const values = {
      accountId: ctx.accountId,
      channelId,
      enabled: body.enabled === true,
      mode,
      systemPrompt:
        typeof body.systemPrompt === 'string' ? body.systemPrompt : null,
      voiceId: typeof body.voiceId === 'string' ? body.voiceId : null,
      greeting: typeof body.greeting === 'string' ? body.greeting : null,
      updatedAt: new Date().toISOString(),
    }
    await db
      .insert(voiceAgents)
      .values(values)
      .onConflictDoUpdate({
        target: voiceAgents.channelId,
        set: {
          enabled: values.enabled,
          mode: values.mode,
          systemPrompt: values.systemPrompt,
          voiceId: values.voiceId,
          greeting: values.greeting,
          updatedAt: values.updatedAt,
        },
      })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
