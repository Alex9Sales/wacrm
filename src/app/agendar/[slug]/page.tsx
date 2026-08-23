// ============================================================
// /agendar/[slug] — PÁGINA PÚBLICA de agendamento (tipo Calendly, sem auth).
// O lead escolhe dia/horário nas janelas do dono → evento na agenda + lead no
// funil + confirmação no WhatsApp. Slots calculados no servidor (fuso da conta).
// ============================================================
import type { Metadata } from 'next'

import { getPublicScheduler, computeSlots } from '@/lib/scheduling/public'
import { BookingClient } from './booking-client'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const s = await getPublicScheduler(slug)
  const title = s?.headline || s?.name || 'Agendar horário'
  return {
    title,
    description: s?.description ?? undefined,
    robots: { index: false },
  }
}

export default async function PublicSchedulerPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const scheduler = await getPublicScheduler(slug)

  if (!scheduler) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
        <div className="max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">
            Página de agendamento indisponível
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Este link pode ter sido desativado ou está incorreto.
          </p>
        </div>
      </main>
    )
  }

  const days = await computeSlots(scheduler)

  return (
    <BookingClient
      slug={scheduler.slug}
      name={scheduler.headline || scheduler.name}
      description={scheduler.description}
      durationMinutes={scheduler.durationMinutes}
      location={scheduler.location}
      initialDays={days}
    />
  )
}
