// ============================================================
// Webhook do Instagram Direct (DM). Estilo Messenger:
//   • GET  — verificação (hub.mode=subscribe + hub.verify_token + hub.challenge).
//   • POST — recebe `entry[].messaging[]`; roteia pro canal por entry[].id
//            (= id da conta IG = provider_meta->>'ig_id'), verifica a assinatura
//            HMAC (mesmo app secret do Meta) e joga no pipeline agnóstico.
//
// Diferente do webhook do WhatsApp (que roteia por phone_number_id e lê
// entry.changes[].value). Assinatura + criptografia reaproveitadas do Meta.
// ============================================================

import { NextResponse, after } from 'next/server'
import { eq } from 'drizzle-orm'

import { db, channels } from '@/db'
import {
  decryptCredentials,
  loadInstagramChannelByIgId,
} from '@/lib/channels/channels'
import {
  instagramProvider,
  fetchInstagramProfile,
} from '@/lib/channels/providers/instagram'
import { dispatchInboundMessage } from '@/lib/channels/inbound'
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

    // Aceita o token global (env) OU o verifyToken de qualquer canal Instagram.
    // A inscrição do webhook é a NÍVEL DE APP (pode não existir canal ainda),
    // então o env é o caminho principal.
    const envToken = process.env.INSTAGRAM_VERIFY_TOKEN
    if (envToken && verifyToken === envToken) {
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    try {
      const igChannels = await db
        .select({ credentials: channels.credentials })
        .from(channels)
        .where(eq(channels.provider, 'instagram'))
      for (const ch of igChannels) {
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
      console.error('[webhooks/instagram] verify channels error:', err)
    }

    return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 })
  } catch (error) {
    console.error('[webhooks/instagram] GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

interface IgBody {
  object?: string
  entry?: { id?: string }[]
}

// ------------------------------------------------------------
// POST — recebe as mensagens.
// ------------------------------------------------------------
export async function POST(request: Request) {
  const rawBody = await request.text()

  let body: IgBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Roteia pelo id da conta IG (entry[0].id) → canal Instagram.
  const igId = body.entry?.[0]?.id
  const channel = igId ? await loadInstagramChannelByIgId(igId) : null

  // Verifica a assinatura (HMAC via app secret — o canal pode dar o appSecret,
  // senão cai no META_APP_SECRET global).
  const verified = await instagramProvider.verifyWebhook(
    { rawBody, headers: request.headers },
    channel,
  )
  if (!verified) {
    console.warn('[webhooks/instagram] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  if (!channel) {
    // Assinatura ok mas nenhum canal casou o ig_id — ack pra Meta não re-tentar.
    console.warn('[webhooks/instagram] no channel for ig_id', igId)
    return NextResponse.json({ status: 'no_channel' }, { status: 200 })
  }

  after(async () => {
    try {
      const parsed = instagramProvider.parseWebhook(body)
      for (const ev of parsed.messages) {
        try {
          // O webhook só traz o IGSID → busca nome/@username e foto do perfil.
          let profilePic: string | undefined
          if (ev.senderExternalId && !ev.fromMe) {
            const prof = await fetchInstagramProfile(channel, ev.senderExternalId)
            if (prof) {
              if (prof.name || prof.username) {
                ev.senderName = prof.name || `@${prof.username}`
              }
              profilePic = prof.profilePic
            }
          }
          const res = await dispatchInboundMessage(channel, ev)
          // Foto do perfil no contato (só se ainda não tiver avatar).
          if (res?.contactId && profilePic) {
            await db
              .update(contacts)
              .set({ avatarUrl: profilePic })
              .where(
                and(eq(contacts.id, res.contactId), isNull(contacts.avatarUrl)),
              )
          }
        } catch (err) {
          console.error('[webhooks/instagram] dispatch failed:', err)
        }
      }
    } catch (err) {
      console.error('[webhooks/instagram] process error:', err)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
