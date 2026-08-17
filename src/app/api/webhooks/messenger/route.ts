// ============================================================
// Webhook do Facebook Messenger (DM da Página). Estilo Messenger:
//   • GET  — verificação (hub.mode=subscribe + hub.verify_token + hub.challenge).
//   • POST — recebe `entry[].messaging[]`; roteia pro canal por entry[].id
//            (= PAGE ID = provider_meta->>'page_id'), verifica a assinatura HMAC
//            (app secret) e joga no pipeline agnóstico.
//
// Gêmeo do webhook do Instagram — só muda o roteamento (page_id) e o provider.
// ============================================================

import { NextResponse, after } from 'next/server'
import { eq } from 'drizzle-orm'

import { db, channels } from '@/db'
import {
  decryptCredentials,
  loadMessengerChannelByPageId,
} from '@/lib/channels/channels'
import {
  messengerProvider,
  fetchMessengerProfile,
} from '@/lib/channels/providers/messenger'
import { dispatchInboundMessage } from '@/lib/channels/inbound'
import { hasMetaLeadEvents } from '@/lib/leads/providers/meta'
import { processMetaLeadWebhook } from '@/lib/leads/engine'
import { contacts } from '@/db'
import { and, isNull } from 'drizzle-orm'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ------------------------------------------------------------
// GET — verificação do callback.
// ------------------------------------------------------------
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 },
      )
    }

    const envToken = process.env.MESSENGER_VERIFY_TOKEN
    if (envToken && verifyToken === envToken) {
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    try {
      const chans = await db
        .select({ credentials: channels.credentials })
        .from(channels)
        .where(eq(channels.provider, 'messenger'))
      for (const ch of chans) {
        try {
          const creds = decryptCredentials(ch.credentials)
          if (
            typeof creds.verifyToken === 'string' &&
            creds.verifyToken === verifyToken
          ) {
            return new Response(challenge, {
              status: 200,
              headers: { 'Content-Type': 'text/plain' },
            })
          }
        } catch {
          /* credenciais ilegíveis — pula */
        }
      }
    } catch (err) {
      console.error('[webhooks/messenger] verify channels error:', err)
    }

    return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 })
  } catch (error) {
    console.error('[webhooks/messenger] GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

interface FbBody {
  object?: string
  entry?: { id?: string }[]
}

// ------------------------------------------------------------
// POST — recebe as mensagens.
// ------------------------------------------------------------
export async function POST(request: Request) {
  const rawBody = await request.text()

  let body: FbBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const pageId = body.entry?.[0]?.id
  const channel = pageId ? await loadMessengerChannelByPageId(pageId) : null

  const verified = await messengerProvider.verifyWebhook(
    { rawBody, headers: request.headers },
    channel,
  )
  if (!verified) {
    console.warn('[webhooks/messenger] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Meta Lead Ads na MESMA app da Página: o callback da Página é único, então
  // o evento de leadgen chega aqui junto das mensagens. Delega pro motor de
  // leads (roteia por page_id), independente de existir canal Messenger.
  if (hasMetaLeadEvents(body)) {
    after(() => processMetaLeadWebhook(body))
  }

  if (!channel) {
    console.warn('[webhooks/messenger] no channel for page_id', pageId)
    return NextResponse.json({ status: 'no_channel' }, { status: 200 })
  }

  after(async () => {
    try {
      const parsed = messengerProvider.parseWebhook(body)
      for (const ev of parsed.messages) {
        try {
          let profilePic: string | undefined
          if (ev.senderExternalId && !ev.fromMe) {
            const prof = await fetchMessengerProfile(channel, ev.senderExternalId)
            if (prof) {
              if (prof.name) ev.senderName = prof.name
              profilePic = prof.profilePic
            }
          }
          const res = await dispatchInboundMessage(channel, ev)
          if (res?.contactId && profilePic) {
            await db
              .update(contacts)
              .set({ avatarUrl: profilePic })
              .where(
                and(eq(contacts.id, res.contactId), isNull(contacts.avatarUrl)),
              )
          }
        } catch (err) {
          console.error('[webhooks/messenger] dispatch failed:', err)
        }
      }
    } catch (err) {
      console.error('[webhooks/messenger] process error:', err)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
