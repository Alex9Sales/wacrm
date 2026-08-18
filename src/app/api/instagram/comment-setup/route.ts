// ============================================================
// GET /api/instagram/comment-setup?channelId=X → { posts, rules }
//
// Alimenta a galeria de automações de comentário. É uma ROTA DE API (URL
// estável) de propósito: as Server Actions quebram quando o bundle do navegador
// fica velho ("Failed to find Server Action"), e a galeria ficava sem listar os
// posts. Rota estável não sofre disso. Reusa a lógica das actions (auth + fetch).
// ============================================================

import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import {
  listInstagramPosts,
  listCommentAutomations,
} from '@/components/settings/instagram-comments-actions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const channelId = new URL(request.url).searchParams.get('channelId')
    if (!channelId) {
      return NextResponse.json({ error: 'channelId is required' }, { status: 400 })
    }
    const [posts, rules] = await Promise.all([
      listInstagramPosts(channelId),
      listCommentAutomations(channelId),
    ])
    return NextResponse.json({ posts, rules })
  } catch (err) {
    return toErrorResponse(err)
  }
}
