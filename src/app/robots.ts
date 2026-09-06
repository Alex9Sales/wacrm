import type { MetadataRoute } from 'next'

import { SITE_URL } from '@/lib/seo/site'

// O app (inbox, funil, admin…) já é noindex pelo layout raiz; aqui é o que os
// robôs podem PEDIR. Buscadores com IA (ChatGPT Search, Perplexity…) têm
// permissão explícita — aparecer nas respostas deles é objetivo do orgânico.
// O Cloudflare também precisa deixar esses crawlers passarem (sem 403).
export default function robots(): MetadataRoute.Robots {
  const disallow = ['/api/', '/admin/', '/inbox', '/pipelines', '/contacts', '/settings', '/relatorios', '/cobrancas', '/aprovacoes', '/login', '/join/', '/custom-domain/']
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow },
      { userAgent: 'OAI-SearchBot', allow: '/', disallow },
      { userAgent: 'PerplexityBot', allow: '/', disallow },
      { userAgent: 'Claude-SearchBot', allow: '/', disallow },
      { userAgent: 'Google-Extended', allow: '/', disallow },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}
