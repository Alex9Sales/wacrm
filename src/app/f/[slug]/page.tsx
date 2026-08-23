// ============================================================
// /f/[slug] — PÁGINA PÚBLICA de um formulário de captação (sem auth). Resolve o
// form pelo slug e renderiza o formulário; ao enviar, o lead cai no funil da
// conta via /api/public/capture/submit → ingestLead.
// ============================================================
import type { Metadata } from 'next'

import {
  getPublicCaptureForm,
  getPublicCaptureWaHref,
  getPublicSchedulerUrl,
} from '@/lib/capture/public'
import {
  DEFAULT_CAPTURE_HEADLINE,
  DEFAULT_CAPTURE_SUBMIT,
  DEFAULT_CAPTURE_SUCCESS,
} from '@/lib/capture/shared'
import { CaptureFormClient } from './capture-form-client'
import { CaptureLanding } from './landing'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const form = await getPublicCaptureForm(slug)
  const title = form?.headline || form?.name || 'Formulário'
  return {
    title,
    description: form?.description ?? undefined,
    openGraph: { title, description: form?.description ?? undefined },
    robots: { index: false }, // link privado compartilhado; não indexar
  }
}

export default async function PublicCapturePage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const form = await getPublicCaptureForm(slug)

  if (!form) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
        <div className="max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">
            Formulário indisponível
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Este link pode ter sido desativado ou está incorreto.
          </p>
        </div>
      </main>
    )
  }

  const headline = form.headline || form.name || DEFAULT_CAPTURE_HEADLINE
  const submitLabel = form.submitLabel || DEFAULT_CAPTURE_SUBMIT
  const successMessage = form.successMessage || DEFAULT_CAPTURE_SUCCESS
  // Obrigado que Vende: oferta + botão de WhatsApp na tela de sucesso.
  const successWaHref = form.successWhatsapp
    ? await getPublicCaptureWaHref(form, 'sent')
    : null
  const successOffer =
    form.successOfferTitle || form.successOfferText
      ? { title: form.successOfferTitle, text: form.successOfferText }
      : null
  // Mini-site: botão de WhatsApp na landing + botão "Agendar horário".
  const landingWaHref = form.content.showWhatsapp
    ? await getPublicCaptureWaHref(form, 'info')
    : null
  const schedulerUrl = await getPublicSchedulerUrl(
    form.accountId,
    form.content.schedulerSlug,
  )

  if (form.content.mode === 'landing') {
    return (
      <CaptureLanding
        slug={form.slug}
        headline={headline}
        description={form.description}
        fields={form.fields}
        submitLabel={submitLabel}
        successMessage={successMessage}
        content={form.content}
        successOffer={successOffer}
        successWaHref={successWaHref}
        landingWaHref={landingWaHref}
        schedulerUrl={schedulerUrl}
      />
    )
  }

  return (
    <CaptureFormClient
      slug={form.slug}
      headline={headline}
      description={form.description}
      fields={form.fields}
      submitLabel={submitLabel}
      successMessage={successMessage}
      successOffer={successOffer}
      successWaHref={successWaHref}
      successSchedulerUrl={schedulerUrl}
    />
  )
}
