import { NextResponse } from 'next/server'

import {
  getCurrentAccount,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account'
import { loadMetaChannelByAccount } from '@/lib/channels/channels'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    // Resolve the caller's account — the Meta channel is account-
    // scoped, so a teammate fetching media for a conversation in the
    // shared inbox reads the account's channel, not a personal row.
    let ctx: AccountContext
    try {
      ctx = await getCurrentAccount()
    } catch (err) {
      return toErrorResponse(err)
    }

    // Inbound media proxying only applies to Meta — resolve the
    // account's Meta channel for its (already-decrypted) access token.
    const channel = await loadMetaChannelByAccount(ctx.accountId)

    if (!channel) {
      return NextResponse.json(
        { error: 'Nenhum canal oficial (Meta) configurado' },
        { status: 400 }
      )
    }

    const accessToken = channel.credentials.accessToken as string

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
