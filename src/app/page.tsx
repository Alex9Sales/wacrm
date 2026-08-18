import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import {
  MessageSquare,
  GitBranch,
  CalendarDays,
  BarChart3,
  Zap,
  Bot,
  Check,
  Sparkles,
  Workflow,
} from 'lucide-react'
import { getSessionUserId } from '@/lib/auth/session'

export const metadata: Metadata = {
  title: 'FluxiaCRM — CRM de atendimento e vendas no WhatsApp',
  description:
    'O FluxiaCRM é uma plataforma de atendimento e vendas no WhatsApp para pequenas e médias empresas: caixa de entrada compartilhada, funil de vendas, agenda integrada ao Google Calendar, relatórios, automações e agentes de IA. Teste grátis por 7 dias, sem cartão.',
  // A homepage é pública e deve ser rastreável (verificação OAuth do Google +
  // SEO) — sobrepõe o noindex global do layout só para esta rota.
  robots: { index: true, follow: true },
}

const TRIAL_HREF = '/comecar'

const FEATURES = [
  {
    icon: MessageSquare,
    title: 'Atendimento multicanal',
    desc: 'WhatsApp, Instagram Direct e Messenger numa caixa de entrada só: toda a equipe responde os clientes num lugar, em vários números.',
  },
  {
    icon: Bot,
    title: 'Agentes de IA',
    desc: 'Assistentes que respondem, qualificam e dão sequência aos leads sozinhos — com a sua chave e o seu tom.',
  },
  {
    icon: GitBranch,
    title: 'Funil de vendas (CRM)',
    desc: 'Contatos, empresas e negociações organizados em funis, com cada etapa acompanhada até a venda.',
  },
  {
    icon: CalendarDays,
    title: 'Agenda + Google Calendar',
    desc: 'Agende compromissos dentro do CRM, com sincronização com o Google Calendar.',
  },
  {
    icon: Workflow,
    title: 'Automações visuais (comentário → DM)',
    desc: 'Comentou uma palavra no seu post do Instagram? O CRM responde e chama no Direct com botões que levam a pessoa por uma sequência automática — também no WhatsApp e Messenger. Você monta arrastando, sem programar, e vê os cliques e a conversão de cada etapa.',
  },
  {
    icon: Zap,
    title: 'Disparos em massa',
    desc: 'Campanhas para a sua carteira inteira, com acompanhamento de entrega — no número oficial ou no seu WhatsApp.',
  },
  {
    icon: BarChart3,
    title: 'Relatórios',
    desc: 'Painéis de desempenho comercial: funil, conversão, ticket médio e muito mais.',
  },
]

const PLANS = [
  {
    name: 'Essencial',
    price: '497',
    tagline: 'O atendimento e o funil organizados',
    highlighted: false,
    lead: null as string | null,
    features: [
      'Caixa de entrada compartilhada (vários atendentes)',
      'Funil de vendas (CRM), contatos e empresas',
      'Agenda com Google Calendar',
      'Disparos, campanhas e automações',
      'Relatórios comerciais',
    ],
  },
  {
    name: 'Pro',
    price: '799',
    tagline: 'Vendas no automático, com Inteligência Artificial',
    highlighted: true,
    lead: 'Tudo do Essencial, e mais:',
    features: [
      'Agentes de IA que atendem e qualificam sozinhos',
      'Base de Conhecimento (a IA responde com os seus dados)',
      'Follow-up inteligente (reengaja quem some)',
      'IA para Negócios: sugestões no funil',
      'IA proativa acompanhando cada negociação',
    ],
  },
  {
    name: 'Enterprise',
    price: '1.999',
    tagline: 'Voz, ligação e escala com prioridade',
    highlighted: false,
    lead: 'Tudo do Pro, e mais:',
    features: [
      'Ligação pelo WhatsApp',
      'Agente de voz: atende e liga por você (em breve)',
      'Prioridade no suporte e na implantação',
      'Limites ampliados de atendentes, canais e agentes',
    ],
  },
]

export default async function RootPage() {
  // Usuário logado vai direto ao painel; deslogado (e o rastreador do Google)
  // vê o site de vendas público que descreve o FluxiaCRM.
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
        <div className="flex items-center gap-2">
          <a
            href="/login"
            className="rounded-lg px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
          >
            Entrar
          </a>
          <a
            href={TRIAL_HREF}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            Testar grátis
          </a>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-4xl px-6 pb-10 pt-10 text-center sm:pt-20">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          <Sparkles className="h-3.5 w-3.5" /> CRM de WhatsApp com Inteligência Artificial
        </span>
        <h1 className="mt-5 font-heading text-4xl font-bold tracking-tight sm:text-6xl">
          Venda mais no WhatsApp, sem deixar lead sem resposta
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">
          O <strong className="text-foreground">FluxiaCRM</strong> junta{' '}
          <strong className="text-foreground">
            WhatsApp, Instagram e Messenger, funil de vendas e agentes de IA
          </strong>{' '}
          num só lugar. Sua equipe atende todos os canais numa caixa de entrada
          só, a IA responde e qualifica sozinha, e nada se perde no meio do
          caminho.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href={TRIAL_HREF}
            className="w-full rounded-lg bg-primary px-7 py-3.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 sm:w-auto"
          >
            Começar teste grátis de 7 dias
          </a>
          <a
            href="#planos"
            className="w-full rounded-lg px-7 py-3.5 text-sm font-medium text-foreground ring-1 ring-foreground/15 transition hover:bg-muted sm:w-auto"
          >
            Ver planos
          </a>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Sem cartão de crédito • Configure em minutos • Cancele quando quiser
        </p>
      </section>

      {/* Recursos */}
      <section id="recursos" className="mx-auto max-w-6xl px-6 py-14">
        <h2 className="mb-3 text-center font-heading text-2xl font-semibold sm:text-3xl">
          Tudo o que você precisa pra atender e vender
        </h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-muted-foreground">
          Uma plataforma só, no lugar de cinco ferramentas soltas.
        </p>
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

      {/* Diferencial — o que nos separa dos concorrentes (tudo verdade hoje) */}
      <section className="mx-auto max-w-6xl px-6 py-14">
        <div className="rounded-2xl bg-card p-8 ring-1 ring-foreground/10 sm:p-12">
          <h2 className="text-center font-heading text-2xl font-semibold sm:text-3xl">
            Não é &ldquo;só mais um chatbot de WhatsApp&rdquo;
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-muted-foreground">
            É o único CRM que junta{' '}
            <strong className="text-foreground">todos os seus canais</strong> e
            uma IA que realmente{' '}
            <strong className="text-foreground">atende, qualifica e vende</strong>
            .
          </p>
          <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
            <div>
              <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <MessageSquare className="h-5 w-5" />
              </span>
              <h3 className="font-heading text-base font-medium">
                Todos os canais num inbox só
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                WhatsApp, Instagram Direct e Messenger na mesma caixa de entrada.
                Sua equipe responde tudo num lugar, sem ficar trocando de aba nem
                de aparelho.
              </p>
            </div>
            <div>
              <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Bot className="h-5 w-5" />
              </span>
              <h3 className="font-heading text-base font-medium">
                IA que atende de verdade
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Com a sua chave e o seu tom. Responde com a sua base de
                conhecimento, qualifica o lead, reengaja quem some e sugere o
                próximo passo no funil — não é só um bot de agendamento.
              </p>
            </div>
            <div>
              <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Sparkles className="h-5 w-5" />
              </span>
              <h3 className="font-heading text-base font-medium">
                Comece sem travas
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                7 dias grátis, sem cartão e sem taxa de implantação. Você
                configura em minutos e cancela quando quiser — sem contrato preso
                por meses.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Planos */}
      <section id="planos" className="mx-auto max-w-6xl px-6 py-14">
        <h2 className="mb-3 text-center font-heading text-2xl font-semibold sm:text-3xl">
          Planos simples, sem pegadinha
        </h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-muted-foreground">
          Comece com <strong className="text-foreground">7 dias grátis</strong>, sem
          cartão. Escolha o plano quando decidir continuar.
        </p>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {PLANS.map((p) => (
            <div
              key={p.name}
              className={`relative flex flex-col rounded-2xl bg-card p-6 ring-1 ${
                p.highlighted
                  ? 'ring-2 ring-primary shadow-lg'
                  : 'ring-foreground/10'
              }`}
            >
              {p.highlighted && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
                  Mais escolhido
                </span>
              )}
              <h3 className="font-heading text-lg font-semibold">Plano {p.name}</h3>
              <p className="mt-1 min-h-10 text-sm text-muted-foreground">{p.tagline}</p>
              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-sm text-muted-foreground">R$</span>
                <span className="font-heading text-4xl font-bold">{p.price}</span>
                <span className="text-sm text-muted-foreground">/mês</span>
              </div>
              {p.lead && (
                <p className="mt-5 text-xs font-medium text-muted-foreground">
                  {p.lead}
                </p>
              )}
              <ul className={`${p.lead ? 'mt-2' : 'mt-5'} space-y-2.5`}>
                {p.features.map((inc) => (
                  <li key={inc} className="flex items-start gap-2 text-sm">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span className="text-foreground">{inc}</span>
                  </li>
                ))}
              </ul>
              <a
                href={TRIAL_HREF}
                className={`mt-6 rounded-lg px-4 py-3 text-center text-sm font-semibold transition ${
                  p.highlighted
                    ? 'bg-primary text-primary-foreground hover:opacity-90'
                    : 'text-foreground ring-1 ring-foreground/15 hover:bg-muted'
                }`}
              >
                Testar 7 dias grátis
              </a>
            </div>
          ))}
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Implantação (setup) sob consulta. Precisa de algo específico?{' '}
          <a href="/login" className="text-primary hover:underline">
            Fale com a gente
          </a>
          .
        </p>
      </section>

      {/* CTA final */}
      <section className="mx-auto max-w-6xl px-6 py-14">
        <div className="rounded-2xl bg-primary px-6 py-12 text-center text-primary-foreground">
          <h2 className="font-heading text-2xl font-bold sm:text-3xl">
            Experimente 7 dias grátis
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-primary-foreground/85">
            Conecte seu WhatsApp e veja a IA atendendo hoje. Sem cartão, sem
            compromisso.
          </p>
          <a
            href={TRIAL_HREF}
            className="mt-6 inline-block rounded-lg bg-background px-7 py-3.5 text-sm font-semibold text-foreground transition hover:opacity-90"
          >
            Começar agora
          </a>
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
