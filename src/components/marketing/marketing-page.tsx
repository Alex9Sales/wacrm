// ============================================================
// 📄 Página de conteúdo pública (SEO/AEO): uma spec em dados vira HTML
// indexável com hierarquia real (h1 → h2), FAQ, CTA e JSON-LD
// (BreadcrumbList + Article + FAQPage). Regra de conteúdo: toda página
// responde uma pergunta real de negócio e traz pelo menos um exemplo
// concreto do Fluxia — nada de página só pra palavra-chave.
// ============================================================

import type { Metadata } from 'next'

import { ArrowRight } from 'lucide-react'

import { articleJsonLd, breadcrumbJsonLd, faqJsonLd, jsonLdScript } from '@/lib/seo/jsonld'
import { absoluteUrl, TRIAL_PATH, WHATSAPP_URL } from '@/lib/seo/site'

import { SiteShell } from './site-shell'

export interface PageSection {
  id: string
  h2: string
  paragraphs?: string[]
  bullets?: string[]
  /** Passo a passo numerado (quando a ordem importa de verdade). */
  steps?: { title: string; body: string }[]
  /** Exemplo concreto do produto, destacado. */
  example?: { title: string; body: string }
}

export interface PageSpec {
  path: string
  /** Rótulo curto acima do título (categoria). */
  eyebrow: string
  title: string
  /** 1 parágrafo que já responde a pergunta — é o que a IA cita. */
  intro: string
  metaTitle: string
  metaDescription: string
  ogTitle?: string
  datePublished: string
  dateModified?: string
  sections: PageSection[]
  faq?: { q: string; a: string }[]
  related?: { href: string; label: string }[]
  breadcrumb?: { name: string; path: string }[]
  cta?: { title: string; body: string }
}

export function pageMetadata(spec: PageSpec): Metadata {
  return {
    title: { absolute: spec.metaTitle },
    description: spec.metaDescription,
    // O layout raiz é noindex (área logada); páginas de conteúdo sobrepõem.
    robots: { index: true, follow: true },
    alternates: { canonical: spec.path },
    openGraph: {
      title: spec.ogTitle ?? spec.title,
      description: spec.metaDescription,
      url: spec.path,
      type: 'article',
      siteName: 'FluxiaCRM',
      locale: 'pt_BR',
      images: [{ url: absoluteUrl('/opengraph-image'), width: 1200, height: 630, alt: spec.title }],
    },
    twitter: { card: 'summary_large_image', title: spec.ogTitle ?? spec.title, description: spec.metaDescription },
  }
}

export function MarketingPage({ spec }: { spec: PageSpec }) {
  const trail = spec.breadcrumb ?? [{ name: 'Início', path: '/' }, { name: spec.eyebrow, path: spec.path }]
  const cta = spec.cta ?? {
    title: 'Veja isso rodando no seu WhatsApp',
    body: 'Teste grátis por 7 dias, sem cartão. Conecte um número, suba seus materiais e deixe o agente atender enquanto você acompanha.',
  }
  return (
    <SiteShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(breadcrumbJsonLd(trail)) }} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdScript(
            articleJsonLd({ path: spec.path, headline: spec.title, description: spec.metaDescription, datePublished: spec.datePublished, dateModified: spec.dateModified }),
          ),
        }}
      />
      {spec.faq?.length ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(faqJsonLd(spec.faq)) }} /> : null}

      <main className="mx-auto max-w-3xl px-6 pb-20 pt-14">
        <nav aria-label="Você está em" className="text-xs text-muted-foreground">
          <ol className="flex flex-wrap items-center gap-1.5">
            {trail.map((t, i) => (
              <li key={t.path} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden="true">/</span>}
                {i < trail.length - 1 ? (
                  <a href={t.path} className="hover:text-foreground">
                    {t.name}
                  </a>
                ) : (
                  <span className="text-foreground">{t.name}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>

        <article>
          <p className="mt-8 text-xs font-semibold uppercase tracking-[0.12em] text-primary">{spec.eyebrow}</p>
          <h1 className="mt-2 text-balance font-heading text-4xl font-bold leading-[1.08] tracking-[-0.03em] sm:text-5xl">{spec.title}</h1>
          <p className="mt-6 text-lg leading-relaxed text-muted-foreground">{spec.intro}</p>

          {spec.sections.map((s) => (
            <section key={s.id} id={s.id} className="mt-12">
              <h2 className="font-heading text-2xl font-semibold tracking-[-0.02em]">{s.h2}</h2>
              {s.paragraphs?.map((p, i) => (
                <p key={i} className="mt-4 leading-relaxed text-foreground/90">
                  {p}
                </p>
              ))}
              {s.bullets?.length ? (
                <ul className="mt-4 flex flex-col gap-2 pl-5">
                  {s.bullets.map((b) => (
                    <li key={b} className="list-disc leading-relaxed text-foreground/90">
                      {b}
                    </li>
                  ))}
                </ul>
              ) : null}
              {s.steps?.length ? (
                <ol className="mt-5 flex flex-col gap-4">
                  {s.steps.map((st, i) => (
                    <li key={st.title} className="flex gap-4">
                      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">{i + 1}</span>
                      <div>
                        <p className="font-semibold">{st.title}</p>
                        <p className="mt-1 leading-relaxed text-foreground/90">{st.body}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : null}
              {s.example ? (
                <div className="mt-5 rounded-xl border border-primary/30 bg-primary/5 p-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">Exemplo real</p>
                  <p className="mt-1.5 font-semibold">{s.example.title}</p>
                  <p className="mt-1.5 leading-relaxed text-foreground/90">{s.example.body}</p>
                </div>
              ) : null}
            </section>
          ))}

          {spec.faq?.length ? (
            <section id="perguntas" className="mt-14">
              <h2 className="font-heading text-2xl font-semibold tracking-[-0.02em]">Perguntas frequentes</h2>
              <dl className="mt-5 flex flex-col gap-5">
                {spec.faq.map((f) => (
                  <div key={f.q}>
                    <dt className="font-semibold">{f.q}</dt>
                    <dd className="mt-1.5 leading-relaxed text-foreground/90">{f.a}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
        </article>

        <aside className="mt-14 rounded-2xl border border-border bg-card p-7">
          <p className="font-heading text-xl font-semibold">{cta.title}</p>
          <p className="mt-2 leading-relaxed text-muted-foreground">{cta.body}</p>
          <div className="mt-5 flex flex-col gap-3 sm:flex-row">
            <a href={TRIAL_PATH} className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover">
              Começar teste grátis de 7 dias
              <ArrowRight className="size-4" aria-hidden="true" />
            </a>
            <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center rounded-lg px-6 py-3 text-sm font-medium text-foreground ring-1 ring-border transition hover:bg-muted">
              Falar com a gente no WhatsApp
            </a>
          </div>
        </aside>

        {spec.related?.length ? (
          <nav aria-label="Leia também" className="mt-10">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Leia também</p>
            <ul className="mt-3 flex flex-wrap gap-2">
              {spec.related.map((r) => (
                <li key={r.href}>
                  <a href={r.href} className="inline-block rounded-full border border-border px-3.5 py-1.5 text-sm text-muted-foreground transition hover:border-foreground/40 hover:text-foreground">
                    {r.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </main>
    </SiteShell>
  )
}
