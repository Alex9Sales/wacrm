// Landing page pública da Captação (modo 'landing'): hero + benefícios + prova
// social + o formulário embutido. Server component; o form interativo é o
// CaptureFormClient. Tema "papel" (claro), cor de destaque da conta.
import type { CaptureContent, CaptureField } from "@/lib/capture/shared";
import { CaptureFormClient } from "./capture-form-client";

export function CaptureLanding({
  slug,
  headline,
  description,
  fields,
  submitLabel,
  successMessage,
  content,
  successOffer,
  successWaHref,
  landingWaHref,
  schedulerUrl,
}: {
  slug: string;
  headline: string;
  description: string | null;
  fields: CaptureField[];
  submitLabel: string;
  successMessage: string;
  content: CaptureContent;
  successOffer?: { title: string | null; text: string | null } | null;
  successWaHref?: string | null;
  /** Botão "💬 WhatsApp" da landing (link rastreado, mensagem pré-envio). */
  landingWaHref?: string | null;
  /** Botão "📅 Agendar horário" (página de agendamento da conta). */
  schedulerUrl?: string | null;
}) {
  const accent = content.brandColor || "#7c3aed";

  return (
    <main className="min-h-screen bg-white text-slate-900">
      {/* Hero */}
      <section
        className="border-b border-slate-100"
        style={{
          background: `linear-gradient(180deg, ${accent}0f 0%, #ffffff 100%)`,
        }}
      >
        <div className="mx-auto grid max-w-5xl items-center gap-8 px-5 py-12 sm:py-16 md:grid-cols-2">
          <div>
            {content.logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={content.logo}
                alt="logo"
                className="mb-5 h-10 w-auto max-w-[180px] object-contain"
              />
            ) : null}
            <h1 className="text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-4xl">
              {headline}
            </h1>
            {description ? (
              <p className="mt-3 max-w-md text-base text-slate-600">
                {description}
              </p>
            ) : null}
            <div className="mt-6 flex flex-wrap items-center gap-2.5">
              <a
                href="#capture-form"
                className="inline-flex items-center rounded-xl px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
                style={{ background: accent }}
              >
                {content.ctaText || submitLabel}
              </a>
              {landingWaHref ? (
                <a
                  href={landingWaHref}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500 bg-white px-4 py-3 text-sm font-semibold text-emerald-600 transition hover:bg-emerald-50"
                >
                  💬 WhatsApp
                </a>
              ) : null}
              {schedulerUrl ? (
                <a
                  href={schedulerUrl}
                  className="inline-flex items-center gap-1.5 rounded-xl border bg-white px-4 py-3 text-sm font-semibold transition hover:opacity-80"
                  style={{ borderColor: accent, color: accent }}
                >
                  📅 Agendar horário
                </a>
              ) : null}
            </div>
          </div>
          {content.heroImage ? (
            <div className="order-first md:order-last">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={content.heroImage}
                alt=""
                className="mx-auto max-h-80 w-full rounded-2xl object-cover shadow-lg"
              />
            </div>
          ) : null}
        </div>
      </section>

      {/* Benefícios */}
      {content.benefits.length > 0 ? (
        <section className="mx-auto max-w-5xl px-5 py-12">
          {content.benefitsTitle ? (
            <h2 className="mb-8 text-center text-2xl font-bold text-slate-900">
              {content.benefitsTitle}
            </h2>
          ) : null}
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {content.benefits.map((b, i) => (
              <div
                key={i}
                className="rounded-2xl border border-slate-200 bg-white p-5"
              >
                <div
                  className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold text-white"
                  style={{ background: accent }}
                >
                  {i + 1}
                </div>
                {b.title ? (
                  <h3 className="text-base font-semibold text-slate-900">
                    {b.title}
                  </h3>
                ) : null}
                {b.description ? (
                  <p className="mt-1 text-sm leading-relaxed text-slate-600">
                    {b.description}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Prova social */}
      {content.testimonials.length > 0 ? (
        <section className="border-y border-slate-100 bg-slate-50">
          <div className="mx-auto max-w-5xl px-5 py-12">
            <div className="grid gap-5 sm:grid-cols-2">
              {content.testimonials.map((t, i) => (
                <figure
                  key={i}
                  className="rounded-2xl border border-slate-200 bg-white p-5"
                >
                  <blockquote className="text-sm leading-relaxed text-slate-700">
                    “{t.quote}”
                  </blockquote>
                  {(t.author || t.role) && (
                    <figcaption className="mt-3 text-xs text-slate-500">
                      <strong className="text-slate-700">{t.author}</strong>
                      {t.author && t.role ? " · " : ""}
                      {t.role}
                    </figcaption>
                  )}
                </figure>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* Formulário */}
      <section id="capture-form" className="mx-auto max-w-md px-5 py-14">
        <CaptureFormClient
          slug={slug}
          headline={content.ctaText || "Preencha e comece"}
          description={null}
          fields={fields}
          submitLabel={submitLabel}
          successMessage={successMessage}
          accent={accent}
          embedded
          successOffer={successOffer}
          successWaHref={successWaHref}
          successSchedulerUrl={schedulerUrl}
        />
      </section>

      <p className="pb-8 text-center text-[11px] text-slate-400">
        Feito com Fluxia
      </p>
    </main>
  );
}
