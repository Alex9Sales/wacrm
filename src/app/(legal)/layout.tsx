import type { ReactNode } from 'react';
import { FluxiaMark } from '@/components/brand/fluxia-logo';

// Public legal pages (Terms, Privacy, Data Deletion) live OUTSIDE the
// (dashboard) group, so the auth middleware leaves them reachable without a
// session — which is exactly what Meta's App Review validators require. Own
// light shell so they read cleanly regardless of the app theme.
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-gray-800">
      <div className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
        <a
          href="https://crm.salestecnologia.com.br"
          className="mb-8 inline-flex items-center gap-2 text-sm font-semibold text-violet-700"
        >
          <FluxiaMark className="size-6 text-violet-700" />
          FluxiaCRM
        </a>
        <article className="legal-prose">{children}</article>
        <footer className="mt-12 border-t border-gray-200 pt-6 text-xs text-gray-500">
          Sales Tecnologia · FluxiaCRM — WhatsApp Business Platform.{' '}
          <a href="/privacidade" className="text-violet-700 hover:underline">
            Privacidade
          </a>{' '}
          ·{' '}
          <a href="/termos" className="text-violet-700 hover:underline">
            Termos
          </a>{' '}
          ·{' '}
          <a href="/exclusao-de-dados" className="text-violet-700 hover:underline">
            Exclusão de dados
          </a>
        </footer>
      </div>
      {/* Scoped typography so we don't depend on a Tailwind typography plugin. */}
      <style>{`
        .legal-prose h1 { font-size: 1.75rem; font-weight: 700; color: #111827; margin-bottom: .25rem; }
        .legal-prose h2 { font-size: 1.15rem; font-weight: 600; color: #111827; margin-top: 1.75rem; margin-bottom: .5rem; }
        .legal-prose p, .legal-prose li { line-height: 1.7; color: #374151; }
        .legal-prose p { margin-bottom: .75rem; }
        .legal-prose ul { list-style: disc; padding-left: 1.25rem; margin-bottom: .75rem; }
        .legal-prose li { margin-bottom: .35rem; }
        .legal-prose a { color: #6d28d9; }
        .legal-prose a:hover { text-decoration: underline; }
        .legal-prose .updated { color: #6b7280; font-size: .85rem; margin-bottom: 1.5rem; }
        .legal-prose strong { color: #111827; }
      `}</style>
    </div>
  );
}
