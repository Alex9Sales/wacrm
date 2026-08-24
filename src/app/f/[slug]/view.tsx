// ============================================================
// View pública COMPARTILHADA de uma página de captação. Usada por:
//   - /f/[slug] (host principal)
//   - /custom-domain/[host]/[[...slug]] (domínio próprio do cliente)
//   - /f/[slug]?embed=1 (iframe do widget embutível)
// Resolve os hrefs (zap rastreado, agendamento), injeta o Pixel/GA4 quando
// configurados e escolhe o modo (form | landing | quiz | embed).
// ============================================================
import {
  getPublicCaptureWaHref,
  getPublicSchedulerUrl,
  type PublicCaptureForm,
} from '@/lib/capture/public'
import {
  DEFAULT_CAPTURE_HEADLINE,
  DEFAULT_CAPTURE_SUBMIT,
  DEFAULT_CAPTURE_SUCCESS,
} from '@/lib/capture/shared'
import { meshGradientBackground } from '@/lib/capture/hero-art'
import { CaptureFormClient } from './capture-form-client'
import { CaptureLanding } from './landing'
import { CaptureQuizClient } from './quiz-client'
import { CaptureChatClient } from './chat-client'
import { TrackingScripts } from './tracking-scripts'

export async function PublicCaptureView({
  form,
  embed = false,
}: {
  form: PublicCaptureForm
  /** true = dentro do iframe do widget (só o miolo, sem hero/benefícios). */
  embed?: boolean
}) {
  const headline = form.headline || form.name || DEFAULT_CAPTURE_HEADLINE
  const submitLabel = form.submitLabel || DEFAULT_CAPTURE_SUBMIT
  const successMessage = form.successMessage || DEFAULT_CAPTURE_SUCCESS
  const accent = form.content.brandColor || '#7c3aed'
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

  const tracking =
    form.content.tracking.metaPixelId || form.content.tracking.ga4Id ? (
      <TrackingScripts
        metaPixelId={form.content.tracking.metaPixelId}
        ga4Id={form.content.tracking.ga4Id}
      />
    ) : null

  // 🧩 Modo embed (iframe do widget): só o miolo, ocupando o iframe inteiro.
  if (embed) {
    if (form.content.mode === 'landing' && form.content.chat.enabled) {
      return (
        <main className="h-screen bg-white p-0">
          {tracking}
          <CaptureChatClient
            slug={form.slug}
            greeting={
              form.content.chat.greeting ||
              'Oi! 👋 Pode perguntar o que quiser — e se preferir, já deixo seu contato com a equipe.'
            }
            accent={accent}
            logo={form.content.logo}
            fill
          />
        </main>
      )
    }
    if (form.content.mode === 'quiz' && form.content.quiz.questions.length > 0) {
      return (
        <>
          {tracking}
          <CaptureQuizClient
            slug={form.slug}
            headline={headline}
            description={form.description}
            ctaStart={form.content.ctaText || 'Começar'}
            questions={form.content.quiz.questions}
            fields={form.fields}
            submitLabel={submitLabel}
            accent={accent}
            logo={form.content.logo}
            background="#ffffff"
            aiEnabled={form.content.quiz.aiResult}
            successOffer={successOffer}
            successWaHref={successWaHref}
            successSchedulerUrl={schedulerUrl}
          />
        </>
      )
    }
    return (
      <main className="flex min-h-screen items-start justify-center bg-white p-3">
        {tracking}
        <CaptureFormClient
          slug={form.slug}
          headline={headline}
          description={form.description}
          fields={form.fields}
          submitLabel={submitLabel}
          successMessage={successMessage}
          accent={accent}
          embedded
          successOffer={successOffer}
          successWaHref={successWaHref}
          successSchedulerUrl={schedulerUrl}
        />
      </main>
    )
  }

  // Quiz com IA: perguntas → contato → diagnóstico personalizado na tela.
  // Sem perguntas configuradas, cai no formulário simples (defensivo).
  if (form.content.mode === 'quiz' && form.content.quiz.questions.length > 0) {
    return (
      <>
        {tracking}
        <CaptureQuizClient
          slug={form.slug}
          headline={headline}
          description={form.description}
          ctaStart={form.content.ctaText || 'Começar'}
          questions={form.content.quiz.questions}
          fields={form.fields}
          submitLabel={submitLabel}
          accent={accent}
          logo={form.content.logo}
          background={meshGradientBackground(accent, form.slug)}
          aiEnabled={form.content.quiz.aiResult}
          successOffer={successOffer}
          successWaHref={successWaHref}
          successSchedulerUrl={schedulerUrl}
        />
      </>
    )
  }

  if (form.content.mode === 'landing') {
    return (
      <>
        {tracking}
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
      </>
    )
  }

  return (
    <>
      {tracking}
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
    </>
  )
}
