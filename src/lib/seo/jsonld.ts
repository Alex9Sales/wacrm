// ============================================================
// 🧩 JSON-LD (schema.org) — objetos prontos para <script type="application/ld+json">.
// Só fatos verificáveis: preço vem de PLAN_PRICES_BRL, entidade é a Sales
// Tecnologia. Nada de nota/avaliação inventada.
// ============================================================

import { absoluteUrl, INSTAGRAM_URL, ORG_CITY, ORG_COUNTRY, ORG_NAME, ORG_REGION, PLAN_PRICES_BRL, SITE_NAME, SITE_URL, TAGLINE, WHATSAPP_URL } from './site'

export function organizationJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${SITE_URL}/#organization`,
    name: ORG_NAME,
    alternateName: SITE_NAME,
    url: SITE_URL,
    logo: absoluteUrl('/icon'),
    sameAs: [INSTAGRAM_URL],
    address: { '@type': 'PostalAddress', addressLocality: ORG_CITY, addressRegion: ORG_REGION, addressCountry: ORG_COUNTRY },
    contactPoint: [{ '@type': 'ContactPoint', contactType: 'sales', url: WHATSAPP_URL, availableLanguage: ['pt-BR'] }],
  }
}

export function softwareApplicationJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    '@id': `${SITE_URL}/#software`,
    name: SITE_NAME,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description: `${SITE_NAME} — ${TAGLINE}. Atende no WhatsApp, Instagram, Messenger e e-mail, conhece o histórico do cliente, faz follow-up e executa ações dentro das regras da empresa, com supervisão humana.`,
    url: SITE_URL,
    inLanguage: 'pt-BR',
    publisher: { '@id': `${SITE_URL}/#organization` },
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'BRL',
      lowPrice: String(PLAN_PRICES_BRL.start),
      highPrice: String(PLAN_PRICES_BRL.enterprise),
      offerCount: 4,
      description: 'Teste grátis de 7 dias, sem cartão. Consumo de IA pago direto ao provedor, com a chave do próprio cliente.',
    },
  }
}

export function faqJsonLd(items: { q: string; a: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((i) => ({
      '@type': 'Question',
      name: i.q,
      acceptedAnswer: { '@type': 'Answer', text: i.a },
    })),
  }
}

export function breadcrumbJsonLd(trail: { name: string; path: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: t.name,
      item: absoluteUrl(t.path),
    })),
  }
}

export function articleJsonLd(input: { path: string; headline: string; description: string; datePublished: string; dateModified?: string }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: input.headline,
    description: input.description,
    inLanguage: 'pt-BR',
    datePublished: input.datePublished,
    dateModified: input.dateModified ?? input.datePublished,
    mainEntityOfPage: absoluteUrl(input.path),
    author: { '@type': 'Organization', name: ORG_NAME, url: SITE_URL },
    publisher: { '@id': `${SITE_URL}/#organization` },
  }
}

/** Serializa com escape do "<" — JSON-LD dentro de HTML nunca pode fechar a tag. */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}
