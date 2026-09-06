import type { MetadataRoute } from 'next'

import { absoluteUrl, PUBLIC_PAGES } from '@/lib/seo/site'

/** Só páginas públicas e indexáveis. Uma nova página entra em PUBLIC_PAGES e aparece aqui. */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()
  return PUBLIC_PAGES.map((p) => ({
    url: absoluteUrl(p.path),
    lastModified: now,
    changeFrequency: p.changeFrequency,
    priority: p.priority,
  }))
}
