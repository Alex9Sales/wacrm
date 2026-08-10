import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import {
  MessageSquare,
  GitBranch,
  CalendarDays,
  BarChart3,
  Zap,
  Bot,
} from 'lucide-react'
import { getSessionUserId } from '@/lib/auth/session'

export const metadata: Metadata = {
  title: 'FluxiaCRM — CRM de atendimento e vendas no WhatsApp',
  description:
    'O FluxiaCRM é uma plataforma de atendimento e vendas no WhatsApp para pequenas e médias empresas: caixa de entrada compartilhada, funil de vendas, agenda integrada ao Google Calendar, relatórios, automações e agentes de IA.',
  // A homepage é pública e deve ser rastreável (verificação OAuth do Google +
  // SEO) — sobrepõe o noindex global do layout só para esta rota.
  robots: { index: true, follow: true },
}

const FEATURES = [
  {
    icon: MessageSquare,
    title: 'Atendimento no WhatsApp',
    desc: 'Caixa de entrada compartilhada para toda a equipe responder os clientes num só lugar.',
  },
  {
    icon: GitBranch,
    title: 'Funil de vendas (CRM)',
    desc: 'Organize contatos, empresas e negociações em funis e acompanhe cada etapa até a venda.',
  },
  {
    icon: CalendarDays,
    title: 'Agenda + Google Calendar',
    desc: 'Agende compromissos dentro do CRM com sincronização com o Google Calendar.',
  },
  {
    icon: BarChart3,
    title: 'Relatórios',
    desc: 'Painéis de desempenho comercial: funil, conversão, ticket médio e muito mais.',
  },
  {
    icon: Zap,
    title: 'Automações',
    desc: 'Fluxos e disparos para agilizar o atendimento e a prospecção.',
  },
  {
    icon: Bot,
    title: 'Agentes de IA',
    desc: 'Assistentes de IA que ajudam a atender, qualificar e dar sequência aos leads.',
  },
]

export default async function RootPage() {
  // Usuário logado vai direto ao painel; deslogado (e o rastreador do Google)
  // vê a landing pública que descreve o FluxiaCRM.
  const userId = await getSessionUserId().catch(() => null)
  if (userId) redirect('/dashboard')

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Cabeçalho */}
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary font-heading text-lg font-bold text-primary-foreground">
            F
          </span>
          <span className="font-heading text-xl font-bold">FluxiaCRM</span>
        </div>
        <a
          href="/login"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          Entrar
        </a>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 pb-8 pt-10 text-center sm:pt-16">
        <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
          FluxiaCRM
        </h1>
        <p className="mt-3 text-lg font-semibold text-primary sm:text-xl">
          CRM de atendimento e vendas no WhatsApp
        </p>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
          O <strong className="text-foreground">FluxiaCRM</strong> é um software (CRM) que
          centraliza o <strong className="text-foreground">atendimento e as vendas da sua
          empresa pelo WhatsApp</strong>. Com ele, pequenas e médias empresas reúnem as
          conversas numa caixa de entrada compartilhada, organizam o funil de vendas,
          agendam compromissos e acompanham os resultados — tudo em um só lugar.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <a
            href="/login"
            className="rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            Entrar na plataforma
          </a>
          <a
            href="#recursos"
            className="rounded-lg px-6 py-3 text-sm font-medium text-foreground ring-1 ring-foreground/15 transition hover:bg-muted"
          >
            Conhecer os recursos
          </a>
        </div>
      </section>

      {/* Recursos */}
      <section id="recursos" className="mx-auto max-w-6xl px-6 py-12">
        <h2 className="mb-8 text-center font-heading text-2xl font-semibold">
          O que o FluxiaCRM faz
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
              <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <f.icon className="h-5 w-5" />
              </span>
              <h3 className="font-heading text-base font-medium">{f.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Rodapé */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-6 text-sm text-muted-foreground sm:flex-row">
          <span>© {new Date().getFullYear()} Sales Tecnologia — FluxiaCRM</span>
          <div className="flex items-center gap-4">
            <a href="/privacidade" className="hover:text-foreground">
              Privacidade
            </a>
            <a href="/termos" className="hover:text-foreground">
              Termos
            </a>
            <a href="/login" className="hover:text-foreground">
              Entrar
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
