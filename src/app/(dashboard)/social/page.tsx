import type { Metadata } from 'next'

import { SocialPostsClient } from '@/components/social/social-posts-client'

export const metadata: Metadata = { title: 'Instagram · Publicações' }
export const dynamic = 'force-dynamic'

// /social — publicar no Instagram (post, carrossel, reels, story) de dentro do
// CRM, com agendamento e automação comentário→DM já amarrada ao post.
export default function SocialPage() {
  return <SocialPostsClient />
}
