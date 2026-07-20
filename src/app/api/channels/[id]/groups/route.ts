// ============================================================
// Group monitoring (Fase 1) — opt-in picker API.
//
//   GET    /api/channels/:id/groups          — the channel's WhatsApp groups,
//                                               each flagged monitored or not.
//   POST   /api/channels/:id/groups          — start monitoring one { jid, name }.
//   DELETE /api/channels/:id/groups?jid=...   — stop monitoring it.
//
// Admin-gated (it's channel configuration). Only monitored groups are ingested
// by the inbound pipeline.
// ============================================================

import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db, monitoredGroups } from '@/db'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadChannel } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'

async function channelForAccount(id: string, accountId: string) {
  const ch = await loadChannel(id)
  return ch && ch.accountId === accountId ? ch : null
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const channel = await channelForAccount(id, ctx.accountId)
    if (!channel) {
      return NextResponse.json({ error: 'Canal não encontrado.' }, { status: 404 })
    }
    const provider = getProvider(channel.provider)
    if (!provider.listGroups) {
      return NextResponse.json(
        { error: 'Este canal não suporta grupos.' },
        { status: 400 },
      )
    }
    const [groups, monitored] = await Promise.all([
      provider.listGroups(channel),
      db
        .select({ groupJid: monitoredGroups.groupJid })
        .from(monitoredGroups)
        .where(eq(monitoredGroups.channelId, channel.id)),
    ])
    const monitoredSet = new Set(monitored.map((m) => m.groupJid))
    return NextResponse.json({
      groups: groups.map((g) => ({
        jid: g.jid,
        name: g.name,
        community: g.community,
        monitored: monitoredSet.has(g.jid),
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const channel = await channelForAccount(id, ctx.accountId)
    if (!channel) {
      return NextResponse.json({ error: 'Canal não encontrado.' }, { status: 404 })
    }
    const body = (await request.json().catch(() => ({}))) as {
      jid?: unknown
      name?: unknown
    }
    const jid = typeof body.jid === 'string' ? body.jid.trim() : ''
    if (!jid) {
      return NextResponse.json({ error: 'jid required' }, { status: 400 })
    }
    await db
      .insert(monitoredGroups)
      .values({
        accountId: ctx.accountId,
        channelId: channel.id,
        groupJid: jid,
        groupName: typeof body.name === 'string' ? body.name : null,
      })
      .onConflictDoNothing()
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const channel = await channelForAccount(id, ctx.accountId)
    if (!channel) {
      return NextResponse.json({ error: 'Canal não encontrado.' }, { status: 404 })
    }
    const jid = new URL(request.url).searchParams.get('jid') ?? ''
    if (!jid) {
      return NextResponse.json({ error: 'jid required' }, { status: 400 })
    }
    await db
      .delete(monitoredGroups)
      .where(
        and(
          eq(monitoredGroups.channelId, channel.id),
          eq(monitoredGroups.groupJid, jid),
        ),
      )
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
