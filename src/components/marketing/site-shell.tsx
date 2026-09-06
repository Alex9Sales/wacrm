// ============================================================
// 🌐 Casca das páginas públicas (conteúdo/SEO): cabeçalho + rodapé iguais à
// home, com a navegação das páginas de conteúdo. Server component, HTML
// indexável — nada crítico renderizado só no cliente.
// ============================================================

import { FluxiaLogo } from '@/components/brand/fluxia-logo'
import { TRIAL_PATH, WHATSAPP_URL } from '@/lib/seo/site'

const NAV = [
  { href: '/como-funciona', label: 'Como funciona' },
  { href: '/crm-autonomo', label: 'CRM autônomo' },
  { href: '/agentes-de-ia', label: 'Agentes de IA' },
  { href: '/cases/familia-do-gas', label: 'Case' },
  { href: '/#planos', label: 'Planos' },
]

const CONTEUDO = [
  { href: '/como-funciona', label: 'Como funciona' },
  { href: '/crm-autonomo', label: 'O que é CRM autônomo' },
  { href: '/crm-com-ia', label: 'CRM com IA' },
  { href: '/crm-whatsapp', label: 'CRM para WhatsApp' },
  { href: '/ia-para-vendas', label: 'IA para vendas' },
  { href: '/follow-up-automatico', label: 'Follow-up automático' },
  { href: '/agentes-de-ia', label: 'Agentes de IA' },
  { href: '/customer-intelligence', label: 'Customer Intelligence' },
  { href: '/cases/familia-do-gas', label: 'Case: Família do Gás' },
  { href: '/sobre', label: 'Sobre a Fluxia' },
]

export function SiteShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3.5">
          <a href="/" aria-label="FluxiaCRM, início">
            <FluxiaLogo />
          </a>
          <nav aria-label="Páginas do site" className="hidden md:block">
            <ul className="flex items-center gap-1">
              {NAV.map((item) => (
                <li key={item.href}>
                  <a
                    href={item.href}
                    className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <a href="/login" className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              Entrar
            </a>
            <a href={TRIAL_PATH} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover">
              Testar grátis
            </a>
          </div>
        </div>
      </header>

      {children}

      <footer className="border-t border-border">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 py-12 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <FluxiaLogo />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted-foreground">
              CRM com agentes de IA para quem vende por conversa: atende, conhece o cliente, percebe o momento e age dentro das suas
              regras. Você supervisiona.
            </p>
          </div>
          <div>
            <p className="font-heading text-sm font-semibold">Conteúdo</p>
            <ul className="mt-4 flex flex-col gap-2.5 text-sm">
              {CONTEUDO.map((item) => (
                <li key={item.href}>
                  <a href={item.href} className="inline-block py-1 text-muted-foreground transition-colors hover:text-foreground">
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-heading text-sm font-semibold">Comece</p>
            <ul className="mt-4 flex flex-col gap-2.5 text-sm">
              <li>
                <a href={TRIAL_PATH} className="inline-block py-1 text-muted-foreground transition-colors hover:text-foreground">
                  Teste grátis de 7 dias
                </a>
              </li>
              <li>
                <a href="/diagnostico" className="inline-block py-1 text-muted-foreground transition-colors hover:text-foreground">
                  Diagnóstico gratuito do seu WhatsApp
                </a>
              </li>
              <li>
                <a href="/login" className="inline-block py-1 text-muted-foreground transition-colors hover:text-foreground">
                  Entrar na plataforma
                </a>
              </li>
              <li>
                <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="inline-block py-1 text-muted-foreground transition-colors hover:text-foreground">
                  Falar no WhatsApp
                </a>
              </li>
            </ul>
          </div>
          <div>
            <p className="font-heading text-sm font-semibold">Legal</p>
            <ul className="mt-4 flex flex-col gap-2.5 text-sm">
              <li>
                <a href="/privacidade" className="inline-block py-1 text-muted-foreground transition-colors hover:text-foreground">
                  Privacidade
                </a>
              </li>
              <li>
                <a href="/termos" className="inline-block py-1 text-muted-foreground transition-colors hover:text-foreground">
                  Termos de uso
                </a>
              </li>
              <li>
                <a href="/exclusao-de-dados" className="inline-block py-1 text-muted-foreground transition-colors hover:text-foreground">
                  Exclusão de dados
                </a>
              </li>
            </ul>
          </div>
        </div>
        <div className="border-t border-border/60">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 py-5 text-sm text-muted-foreground sm:flex-row">
            <span>© {new Date().getFullYear()} Sales Tecnologia · FluxiaCRM · Campo Grande, MS</span>
            <span>Feito para quem vende conversando.</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
