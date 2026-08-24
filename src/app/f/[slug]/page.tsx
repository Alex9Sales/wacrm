// ============================================================
// /f/[slug] — PÁGINA PÚBLICA de um formulário de captação (sem auth). Resolve o
// form pelo slug e delega pra view compartilhada (PublicCaptureView), que
// também serve o domínio próprio e o modo embed (?embed=1, iframe do widget).
// ============================================================
import type { Metadata } from 'next'

import { getPublicCaptureForm } from '@/lib/capture/public'
import { PublicCaptureView } from './view'

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
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ embed?: string }>
}) {
  const { slug } = await params
  const { embed } = await searchParams
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

  return <PublicCaptureView form={form} embed={embed === '1'} />
}
