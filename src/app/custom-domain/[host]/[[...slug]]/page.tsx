// ============================================================
// 🌐 Domínio próprio — destino do rewrite por Host feito no middleware.
// Valida o domínio (capture_domains.verified) e serve as páginas de captação
// DA CONTA DONA do domínio:
//   - /            → página padrão (landing ativa mais recente; senão qualquer ativa)
//   - /<slug>      → o form/landing/quiz daquele slug, SE pertencer à conta
// Nunca serve página de outra conta num domínio que não é dela.
// ============================================================
import type { Metadata } from 'next'
import { and, desc, eq } from 'drizzle-orm'

import { db, captureDomains, captureForms } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getPublicCaptureForm, type PublicCaptureForm } from '@/lib/capture/public'
import { normalizeCaptureContent } from '@/lib/capture/shared'
import { PublicCaptureView } from '@/app/f/[slug]/view'

const HOST_RE = /^[a-z0-9][a-z0-9.-]{2,253}$/

async function resolveDomainAccount(hostRaw: string): Promise<string | null> {
  const host = decodeURIComponent(hostRaw ?? '').toLowerCase()
  if (!HOST_RE.test(host)) return null
  const row = firstOrNull(
    await db
      .select({ accountId: captureDomains.accountId })
      .from(captureDomains)
      .where(and(eq(captureDomains.domain, host), eq(captureDomains.verified, true)))
      .limit(1),
  )
  return row?.accountId ?? null
}

/** Página padrão do domínio: landing ativa mais recente; senão qualquer ativa. */
async function defaultFormSlug(accountId: string): Promise<string | null> {
  const rows = await db
    .select({ slug: captureForms.slug, content: captureForms.content })
    .from(captureForms)
    .where(and(eq(captureForms.accountId, accountId), eq(captureForms.active, true)))
    .orderBy(desc(captureForms.createdAt))
    .limit(20)
  if (!rows.length) return null
  const landing = rows.find(
    (r) => normalizeCaptureContent(r.content).mode === 'landing',
  )
  return (landing ?? rows[0]).slug
}

async function loadForm(
  hostRaw: string,
  slugParam: string | undefined,
): Promise<PublicCaptureForm | null> {
  const accountId = await resolveDomainAccount(hostRaw)
  if (!accountId) return null
  const slug = slugParam || (await defaultFormSlug(accountId))
  if (!slug) return null
  const form = await getPublicCaptureForm(slug)
  // A checagem que importa: o form tem que ser DA conta dona do domínio.
  if (!form || form.accountId !== accountId) return null
  return form
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ host: string; slug?: string[] }>
}): Promise<Metadata> {
  const { host, slug } = await params
  const form = await loadForm(host, slug?.[0])
  const title = form?.headline || form?.name || 'Página indisponível'
  return {
    title,
    description: form?.description ?? undefined,
    openGraph: { title, description: form?.description ?? undefined },
    robots: { index: false },
  }
}

export default async function CustomDomainPage({
  params,
}: {
  params: Promise<{ host: string; slug?: string[] }>
}) {
  const { host, slug } = await params
  const form = await loadForm(host, slug?.[0])

  if (!form) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
        <div className="max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">
            Página indisponível
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Este endereço ainda não está ativo ou o link está incorreto.
          </p>
        </div>
      </main>
    )
  }

  return <PublicCaptureView form={form} />
}
