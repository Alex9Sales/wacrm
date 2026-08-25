import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import {
  ArrowRight,
  BarChart3,
  CalendarDays,
  Check,
  FileCheck,
  Magnet,
  MessageSquare,
  Minus,
  ShieldCheck,
  Workflow,
  X,
  Zap,
} from 'lucide-react'
import { getSessionUserId } from '@/lib/auth/session'
import {
  AgentMockup,
  InboxMockup,
  PipelineMockup,
} from '@/components/marketing/product-mockups'
import { FluxiaLogo } from '@/components/brand/fluxia-logo'

export const metadata: Metadata = {
  title: 'FluxiaCRM — CRM de atendimento e vendas no WhatsApp',
  description:
    'O FluxiaCRM é uma plataforma de atendimento e vendas no WhatsApp para pequenas e médias empresas: caixa de entrada compartilhada, funil de vendas, agenda integrada ao Google Calendar, relatórios, automações e agentes de IA. Teste grátis por 7 dias, sem cartão.',
  // A homepage é pública e deve ser rastreável (verificação OAuth do Google +
  // SEO) — sobrepõe o noindex global do layout só para esta rota.
  robots: { index: true, follow: true },
}

const TRIAL_HREF = '/comecar'
const WHATSAPP_HREF =
  'https://wa.me/556791806048?text=Quero%20saber%20mais%20sobre%20o%20FluxiaCRM'

/** Navegação por âncora do cabeçalho fixo. */
const NAV = [
  { href: '#produto', label: 'Produto' },
  { href: '#recursos', label: 'Recursos' },
  { href: '#comparativo', label: 'Comparativo' },
  { href: '#planos', label: 'Planos' },
  { href: '#perguntas', label: 'Perguntas' },
]

/** Contraste antes/depois: a dor concreta de quem vende no WhatsApp. */
const HOJE = [
  'A mensagem chega às 22h e só é vista de manhã',
  'Cada vendedor num número, ninguém sabe quem falou o quê',
  'Comentário no Instagram vira nada',
  'Follow-up só acontece quando alguém lembra',
  'No fim do mês ninguém sabe de onde veio a venda',
]

const COM_FLUXIA = [
  'A IA responde em segundos, 24 horas por dia',
  'Todos os canais e números numa caixa de entrada só',
  'Comentou no post, vira DM e entra no funil',
  'Cadência automática que para quando o cliente responde',
  'Raio-X mostrando quanto cada origem trouxe de venda',
]

/** Os três pilares, cada um com a tela real do produto ao lado. */
const PILARES = [
  {
    id: 'produto',
    title: 'A IA atende enquanto você dorme',
    body: 'O agente responde em segundos, entende áudio, imagem e PDF, puxa a resposta da sua base de conhecimento e fala no seu tom. Ele qualifica, agenda, move o negócio de etapa e chama um humano na hora certa. Roda com a sua chave de IA, então o custo é seu e o controle também.',
    bullets: [
      'Responde em áudio, imagem e PDF',
      'Aprende com os seus arquivos, não inventa',
      'Passa pro humano quando o cliente pede',
    ],
    mockup: <AgentMockup />,
    reverse: false,
  },
  {
    id: 'funil',
    title: 'O funil anda sozinho, e mostra o dinheiro',
    body: 'Cada conversa vira negócio numa etapa. O rodízio distribui os leads novos, o alerta avisa quando um negócio esfria, a previsão de receita mostra o mês antes dele acabar e a IA sugere o próximo passo dentro do card.',
    bullets: [
      'Rodízio automático de leads entre vendedores',
      'Alerta de negócio parado há dias',
      'Previsão de receita por etapa',
    ],
    mockup: <PipelineMockup />,
    reverse: true,
  },
]

/** Recursos secundários: lista densa, não mais um grid de cards iguais. */
const RECURSOS = [
  {
    icon: MessageSquare,
    title: 'Atendimento multicanal',
    desc: 'WhatsApp, Instagram Direct, Messenger e e-mail na mesma caixa, com vários números e a equipe toda dentro.',
  },
  {
    icon: Magnet,
    title: 'Captação embutida',
    desc: 'Landing pages e quiz escritos pela IA, chat que captura na conversa, link de WhatsApp com QR rastreado e widget pra colar em qualquer site.',
  },
  {
    icon: Workflow,
    title: 'Social selling no Instagram',
    desc: 'Comentou no post, recebe DM com botões e vira lead. Respostas que se alternam, opção só pra seguidores e resposta automática a story.',
  },
  {
    icon: CalendarDays,
    title: 'Agenda e agendamento público',
    desc: 'Sua página de horários pro cliente marcar sozinho. Cai na agenda, vira lead no funil, confirma no WhatsApp e sincroniza com o Google Calendar.',
  },
  {
    icon: FileCheck,
    title: 'Propostas com aceite digital',
    desc: 'Monte a proposta com busca automática de CNPJ, envie o link e veja quando o cliente abriu. O aceite fica registrado com data, nome e IP.',
  },
  {
    icon: Zap,
    title: 'Disparos e cadências blindados',
    desc: 'Campanhas por WhatsApp e e-mail com anexos, cadências que pausam na resposta, descadastro automático e ritmo humanizado pra proteger seu número.',
  },
  {
    icon: BarChart3,
    title: 'Relatórios que mostram o dinheiro',
    desc: 'Funil, conversão, meta por vendedor e o Raio-X de campanha. O Sócio IA manda o resumo do dia no seu WhatsApp.',
  },
  {
    icon: ShieldCheck,
    title: 'Controle de acesso e histórico',
    desc: 'Cada atendente com o seu acesso, conversa com histórico completo e nada preso no celular de quem sai da empresa.',
  },
]

const PASSOS = [
  {
    n: '1',
    title: 'Conecte seus canais',
    desc: 'Leia o QR do WhatsApp e ligue Instagram, Messenger e e-mail. Traga seus contatos por planilha.',
  },
  {
    n: '2',
    title: 'Ensine o agente',
    desc: 'Suba sua tabela de preços e suas respostas, escolha o tom de voz e diga até onde ele pode ir.',
  },
  {
    n: '3',
    title: 'Deixe rodando',
    desc: 'A IA atende, qualifica e agenda. Sua equipe entra nas conversas que valem e o funil se move junto.',
  },
]

/**
 * Comparativo honesto: o que o cliente já tentou antes de chegar aqui.
 * `true` = tem, `false` = não tem, `'parcial'` = existe mas capenga.
 */
const COMPARATIVO: {
  linha: string
  chatbot: boolean | 'parcial'
  crm: boolean | 'parcial'
}[] = [
  { linha: 'Responde sozinho fora do horário', chatbot: true, crm: false },
  { linha: 'Entende áudio, imagem e PDF', chatbot: false, crm: false },
  { linha: 'WhatsApp, Instagram e Messenger no mesmo lugar', chatbot: 'parcial', crm: false },
  { linha: 'Funil de vendas de verdade', chatbot: false, crm: true },
  { linha: 'A IA move o negócio de etapa', chatbot: false, crm: false },
  { linha: 'Comentário no Instagram vira lead', chatbot: 'parcial', crm: false },
  { linha: 'Disparo com proteção anti-ban', chatbot: 'parcial', crm: false },
  { linha: 'Proposta com aceite registrado', chatbot: false, crm: 'parcial' },
  { linha: 'Agendamento público que cai na agenda', chatbot: 'parcial', crm: 'parcial' },
]

const PLANS = [
  {
    name: 'Start',
    price: '139,90',
    tagline: 'Pra quem está começando, e cresce com você',
    highlighted: false,
    lead: null as string | null,
    features: [
      '1 atendente, 1 canal de WhatsApp e 1 agente de IA',
      'IA respondendo seus clientes',
      'Funil de vendas (CRM) completo',
      'Captação: landing, quiz e link rastreado',
      'Disparos e cadências',
    ],
  },
  {
    name: 'Essencial',
    price: '497',
    tagline: 'O atendimento e o funil organizados',
    highlighted: false,
    lead: null as string | null,
    features: [
      'Até 6 atendentes, 3 canais e 3 agentes de IA',
      'Caixa de entrada compartilhada',
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
      'Até 15 atendentes e 6 canais',
      'Agentes de IA ilimitados: atendem e qualificam sozinhos',
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
      'Atendentes e canais ilimitados',
    ],
  },
]

const INCLUSO_EM_TODOS = [
  '7 dias grátis, sem cartão',
  'Sem taxa de implantação',
  'Sem fidelidade',
  'Suporte no WhatsApp',
]

const PERGUNTAS = [
  {
    q: 'Meu número corre risco de bloqueio?',
    a: 'É o risco de qualquer disparo em massa no WhatsApp, e por isso a plataforma trabalha contra ele: ritmo humanizado entre os envios, descadastro automático de quem pede pra sair e aviso quando o volume do dia sobe demais. Você também pode separar por número, deixando campanha num canal e atendimento em outro.',
  },
  {
    q: 'Preciso da API oficial da Meta?',
    a: 'Não é obrigatório. Dá pra conectar lendo o QR do seu número atual ou usar a API oficial da Meta, se a sua operação já tiver. Instagram e Messenger conectam pelas contas Meta da sua empresa.',
  },
  {
    q: 'A IA inventa resposta?',
    a: 'Ela responde a partir da Base de Conhecimento que você sobe: tabela de preços, condições, respostas prontas, PDF. Você define o tom de voz e o limite do que ela pode fazer, e ela passa a conversa pro humano quando o cliente pede ou quando sai do escopo.',
  },
  {
    q: 'Já uso outro CRM. Dá pra migrar?',
    a: 'Dá. Você importa seus contatos por planilha e monta o funil com as suas etapas, do jeito que já usa hoje. Quem precisa de uma migração maior fala com a gente e a implantação é feita junto.',
  },
  {
    q: 'Quanto tempo leva pra colocar no ar?',
    a: 'A conexão do WhatsApp é um QR, e o funil já vem pronto pra usar. Dá pra estar atendendo no mesmo dia. Ensinar o agente com os seus materiais é o que leva mais tempo, e é o que faz diferença no resultado.',
  },
  {
    q: 'Tem fidelidade? Como cancelo?',
    a: 'Não tem contrato preso por meses. Você testa 7 dias sem cartão, assina quando decidir continuar (Pix, boleto ou cartão) e cancela quando quiser.',
  },
  {
    q: 'E os dados dos meus clientes?',
    a: 'A conversa e os contatos ficam na sua conta, com acesso por usuário e histórico de quem falou o quê. Você pode pedir a exclusão dos dados a qualquer momento pela página de exclusão de dados.',
  },
]

/**
 * Célula do comparativo. O rótulo acessível vai no próprio ícone
 * (`role="img" + aria-label`) em vez de um `<span class="sr-only">`:
 * o sr-only é `position:absolute` e, sem containing block, escapa do
 * container de rolagem da tabela e cria rolagem horizontal na página
 * inteira no celular.
 */
function ComparativoCell({ value }: { value: boolean | 'parcial' }) {
  if (value === true) {
    return (
      <Check
        role="img"
        aria-label="Tem"
        className="inline size-4 text-foreground/70"
      />
    )
  }
  if (value === 'parcial') {
    return (
      <Minus
        role="img"
        aria-label="Em parte"
        className="inline size-4 text-muted-foreground"
      />
    )
  }
  return (
    <X
      role="img"
      aria-label="Não tem"
      className="inline size-4 text-muted-foreground/45"
    />
  )
}

export default async function RootPage() {
  // Usuário logado vai direto ao painel; deslogado (e o rastreador do Google)
  // vê o site de vendas público que descreve o FluxiaCRM.
  const userId = await getSessionUserId().catch(() => null)
  if (userId) redirect('/dashboard')

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* 📈 Pixel da Meta (conta de anúncios da Fluxia) — PageView do site de
          vendas. A conversão de Lead dispara nas páginas de captação. */}
      <script
        dangerouslySetInnerHTML={{
          __html:
            "!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window, document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init', '942248305058779');fbq('track', 'PageView');",
        }}
      />
      {/* 🧩 Widget da própria Captação: o balão 💬 abre a /f/fluxia (o chat
          com a nossa IA) — o site de vendas usando o produto que vende. */}
      <script
        src="/widget.js"
        data-fluxia="fluxia"
        data-color="#7c3aed"
        async
      />

      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        Pular para o conteúdo
      </a>

      {/* Cabeçalho fixo: a decisão pode ser tomada em qualquer altura da página,
          então o CTA acompanha a rolagem. */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3.5">
          <a href="/" aria-label="FluxiaCRM, início">
            <FluxiaLogo />
          </a>

          <nav aria-label="Seções do site" className="hidden md:block">
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
            <a
              href="/login"
              className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Entrar
            </a>
            <a
              href={TRIAL_HREF}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover"
            >
              Testar grátis
            </a>
          </div>
        </div>
      </header>

      <main id="conteudo">
        {/* Hero: promessa à esquerda, o produto rodando à direita. O único
            momento com movimento da página. */}
        <section className="relative overflow-hidden">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(60%_100%_at_50%_0%,var(--primary-soft),transparent_70%)] opacity-70"
          />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 pb-16 pt-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-16 lg:pb-24 lg:pt-20">
            <div>
              <h1
                className="max-w-xl text-balance font-heading text-[2.5rem] font-bold leading-[1.05] tracking-[-0.035em] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-700 sm:text-6xl"
                style={{ animationFillMode: 'backwards' }}
              >
                Nenhum lead esperando resposta
              </h1>
              <p
                className="mt-5 max-w-lg text-lg leading-relaxed text-muted-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-700"
                style={{ animationDelay: '110ms', animationFillMode: 'backwards' }}
              >
                O FluxiaCRM junta{' '}
                <strong className="font-semibold text-foreground">
                  WhatsApp, Instagram e Messenger
                </strong>{' '}
                numa caixa de entrada só, com{' '}
                <strong className="font-semibold text-foreground">
                  agentes de IA
                </strong>{' '}
                que respondem em segundos, qualificam o lead e movem o funil
                sozinhos. Sua equipe entra quando vale a pena.
              </p>

              <div
                className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-700"
                style={{ animationDelay: '200ms', animationFillMode: 'backwards' }}
              >
                <a
                  href={TRIAL_HREF}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-7 py-3.5 text-sm font-semibold text-primary-foreground shadow-[0_10px_30px_-12px_var(--primary)] transition hover:bg-primary-hover"
                >
                  Começar teste grátis de 7 dias
                  <ArrowRight className="size-4" aria-hidden="true" />
                </a>
                <a
                  href="#planos"
                  className="inline-flex items-center justify-center rounded-lg px-7 py-3.5 text-sm font-medium text-foreground ring-1 ring-border transition hover:bg-muted"
                >
                  Ver planos
                </a>
              </div>

              <p
                className="mt-4 text-sm text-muted-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:duration-700"
                style={{ animationDelay: '280ms', animationFillMode: 'backwards' }}
              >
                Sem cartão de crédito · Configure em minutos · Cancele quando
                quiser
              </p>
            </div>

            <div
              className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-6 motion-safe:duration-1000"
              style={{ animationDelay: '160ms', animationFillMode: 'backwards' }}
            >
              <InboxMockup />
            </div>
          </div>
        </section>

        {/* Canais: prova factual de cobertura, logo abaixo da promessa. */}
        <section className="border-y border-border/60 bg-card/40">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-x-8 gap-y-4 px-6 py-6 md:flex-row md:justify-between">
            <p className="text-sm text-muted-foreground">
              Atende e vende em todos os canais que a sua empresa já usa:
            </p>
            <ul className="flex flex-wrap items-center justify-center gap-x-7 gap-y-3">
              {[
                'WhatsApp',
                'Instagram Direct',
                'Messenger',
                'E-mail',
                'Google Calendar',
              ].map((canal) => (
                <li
                  key={canal}
                  className="text-sm font-medium tracking-tight text-foreground/80"
                >
                  {canal}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* O problema, dito com as palavras do cliente. */}
        <section className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
          <h2 className="max-w-2xl text-balance font-heading text-3xl font-bold tracking-[-0.03em] sm:text-4xl">
            Não é falta de lead. É lead que esfriou esperando.
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
            Todo mundo investe pra fazer o telefone tocar. O dinheiro se perde no
            que acontece depois que ele toca.
          </p>

          <div className="mt-12 grid gap-6 md:grid-cols-2">
            <div className="rounded-2xl border border-border bg-card/50 p-7">
              <p className="font-heading text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Como está hoje
              </p>
              <ul className="mt-5 flex flex-col gap-3.5">
                {HOJE.map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
                    />
                    <span className="text-[15px] leading-relaxed text-muted-foreground">
                      {item}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-2xl border border-primary/25 bg-primary/[0.05] p-7">
              <p className="font-heading text-sm font-semibold uppercase tracking-wide text-foreground">
                Com o FluxiaCRM
              </p>
              <ul className="mt-5 flex flex-col gap-3.5">
                {COM_FLUXIA.map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <Check
                      className="mt-0.5 size-4 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                    <span className="text-[15px] leading-relaxed text-foreground">
                      {item}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* Pilares: cada promessa ao lado da tela que a cumpre. */}
        {PILARES.map((p) => (
          <section
            key={p.id}
            id={p.id}
            className="border-t border-border/60 bg-card/30"
          >
            <div className="mx-auto grid max-w-6xl items-center gap-10 px-6 py-20 lg:grid-cols-2 lg:gap-16 lg:py-24">
              <div className={p.reverse ? 'lg:order-2' : ''}>
                <h2 className="max-w-md text-balance font-heading text-3xl font-bold tracking-[-0.03em] sm:text-4xl">
                  {p.title}
                </h2>
                <p className="mt-5 max-w-lg text-lg leading-relaxed text-muted-foreground">
                  {p.body}
                </p>
                <ul className="mt-7 flex flex-col gap-3">
                  {p.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-3">
                      <Check
                        className="mt-0.5 size-4 shrink-0 text-primary"
                        aria-hidden="true"
                      />
                      <span className="text-[15px] text-foreground">{b}</span>
                    </li>
                  ))}
                </ul>
                <a
                  href={TRIAL_HREF}
                  className="mt-8 inline-flex items-center gap-1.5 py-1 text-sm font-semibold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-all hover:gap-2.5"
                >
                  Testar 7 dias grátis
                  <ArrowRight className="size-4 text-primary" aria-hidden="true" />
                </a>
              </div>
              <div className={p.reverse ? 'lg:order-1' : ''}>{p.mockup}</div>
            </div>
          </section>
        ))}

        {/* Como funciona: a sequência, porque a objeção seguinte é "dá trabalho". */}
        <section className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
          <h2 className="max-w-2xl text-balance font-heading text-3xl font-bold tracking-[-0.03em] sm:text-4xl">
            Do zero ao primeiro atendimento automático no mesmo dia
          </h2>

          <ol className="mt-12 grid gap-10 md:grid-cols-3">
            {PASSOS.map((passo, i) => (
              <li key={passo.n} className="relative">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary font-heading text-sm font-bold text-primary-foreground">
                    {passo.n}
                  </span>
                  {i < PASSOS.length - 1 && (
                    <span
                      aria-hidden="true"
                      className="hidden h-px flex-1 bg-border md:block"
                    />
                  )}
                </div>
                <h3 className="mt-5 font-heading text-lg font-semibold">
                  {passo.title}
                </h3>
                <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
                  {passo.desc}
                </p>
              </li>
            ))}
          </ol>
        </section>

        {/* Recursos secundários: densidade em vez de nove cards iguais. */}
        <section
          id="recursos"
          className="border-y border-border/60 bg-card/30"
        >
          <div className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
            <h2 className="max-w-2xl text-balance font-heading text-3xl font-bold tracking-[-0.03em] sm:text-4xl">
              Uma plataforma no lugar de cinco ferramentas soltas
            </h2>
            <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
              Tudo o que hoje mora em assinaturas separadas, dentro do mesmo
              lugar onde a conversa acontece.
            </p>

            <ul className="mt-12 grid gap-x-12 gap-y-9 md:grid-cols-2">
              {RECURSOS.map((r) => (
                <li key={r.title} className="flex gap-4">
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <r.icon className="size-4.5" aria-hidden="true" />
                  </span>
                  <div>
                    <h3 className="font-heading text-base font-semibold">
                      {r.title}
                    </h3>
                    <p className="mt-1.5 text-[15px] leading-relaxed text-muted-foreground">
                      {r.desc}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Comparativo: enfrenta as duas alternativas que o cliente já tentou. */}
        <section id="comparativo" className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
          <h2 className="max-w-2xl text-balance font-heading text-3xl font-bold tracking-[-0.03em] sm:text-4xl">
            Não é só mais um chatbot de WhatsApp
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
            O chatbot responde e para por aí. O CRM tradicional organiza, mas não
            atende ninguém. O FluxiaCRM faz as duas coisas na mesma conversa.
          </p>

          <div className="relative mt-12 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <caption className="sr-only">
                Comparação entre chatbot de WhatsApp, CRM tradicional e
                FluxiaCRM
              </caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="w-[46%] py-4 pr-4 text-sm font-medium text-muted-foreground">
                    Capacidade
                  </th>
                  <th scope="col" className="px-4 py-4 text-center text-sm font-medium text-muted-foreground">
                    Chatbot de WhatsApp
                  </th>
                  <th scope="col" className="px-4 py-4 text-center text-sm font-medium text-muted-foreground">
                    CRM tradicional
                  </th>
                  <th scope="col" className="rounded-t-xl bg-primary/[0.07] px-4 py-4 text-center font-heading text-sm font-semibold text-foreground">
                    FluxiaCRM
                  </th>
                </tr>
              </thead>
              <tbody>
                {COMPARATIVO.map((row) => (
                  <tr key={row.linha} className="border-b border-border/60">
                    <th
                      scope="row"
                      className="py-3.5 pr-4 text-[15px] font-normal text-foreground"
                    >
                      {row.linha}
                    </th>
                    <td className="px-4 py-3.5 text-center">
                      <ComparativoCell value={row.chatbot} />
                    </td>
                    <td className="px-4 py-3.5 text-center">
                      <ComparativoCell value={row.crm} />
                    </td>
                    <td className="bg-primary/[0.07] px-4 py-3.5 text-center [tr:last-child_&]:rounded-b-xl">
                      <Check
                        role="img"
                        aria-label="Tem"
                        className="inline size-4 text-primary"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/*
          🧱 Prova social — bloco reservado, propositalmente vazio.

          Assim que houver depoimento de cliente real (nome, empresa, foto e
          uma frase de resultado) ou número agregado que a operação possa
          sustentar (empresas atendendo, mensagens processadas, tempo médio de
          primeira resposta), esta é a posição da seção: logo depois do
          comparativo e antes do preço, que é onde a objeção "será que
          funciona pra mim?" aparece.

          Nada aqui é inventado de propósito: prova falsa em landing de SaaS
          B2B é passivo jurídico e queima a marca no primeiro cliente que
          confere.
        */}

        {/* Planos */}
        <section id="planos" className="border-t border-border/60 bg-card/30">
          <div className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
            <h2 className="text-balance text-center font-heading text-3xl font-bold tracking-[-0.03em] sm:text-4xl">
              Planos simples, sem pegadinha
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-center text-lg text-muted-foreground">
              Comece com{' '}
              <strong className="font-semibold text-foreground">
                7 dias grátis
              </strong>
              , sem cartão. Escolha o plano quando decidir continuar.
            </p>

            <div className="mt-12 grid grid-cols-1 items-stretch gap-5 md:grid-cols-2 xl:grid-cols-4">
              {PLANS.map((p) => (
                <div
                  key={p.name}
                  className={`relative flex flex-col rounded-2xl bg-card p-6 ${
                    p.highlighted
                      ? 'ring-2 ring-primary shadow-[0_24px_60px_-30px_var(--primary)] xl:-my-3 xl:py-9'
                      : 'ring-1 ring-border'
                  }`}
                >
                  {p.highlighted && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
                      Mais escolhido
                    </span>
                  )}

                  <h3 className="font-heading text-lg font-semibold">
                    Plano {p.name}
                  </h3>
                  <p className="mt-1 min-h-10 text-sm leading-snug text-muted-foreground">
                    {p.tagline}
                  </p>

                  <div className="mt-5 flex items-baseline gap-1">
                    <span className="text-sm text-muted-foreground">R$</span>
                    <span className="font-heading text-4xl font-bold tracking-[-0.03em]">
                      {p.price}
                    </span>
                    <span className="text-sm text-muted-foreground">/mês</span>
                  </div>

                  <a
                    href={TRIAL_HREF}
                    className={`mt-6 rounded-lg px-4 py-3 text-center text-sm font-semibold transition ${
                      p.highlighted
                        ? 'bg-primary text-primary-foreground hover:bg-primary-hover'
                        : 'text-foreground ring-1 ring-border hover:bg-muted'
                    }`}
                  >
                    Testar 7 dias grátis
                  </a>

                  <p className="mt-6 text-xs font-medium text-muted-foreground">
                    {p.lead ?? 'O que está incluído:'}
                  </p>
                  <ul className="mt-3 flex flex-col gap-2.5">
                    {p.features.map((inc) => (
                      <li key={inc} className="flex items-start gap-2 text-sm">
                        <Check
                          className="mt-0.5 size-4 shrink-0 text-primary"
                          aria-hidden="true"
                        />
                        <span className="leading-snug text-foreground">
                          {inc}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <ul className="mt-10 flex flex-wrap items-center justify-center gap-x-7 gap-y-3">
              {INCLUSO_EM_TODOS.map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <Check
                    className="size-4 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>

            <p className="mt-6 text-center text-sm text-muted-foreground">
              Implantação (setup) sob consulta. Precisa de algo específico?{' '}
              <a
                href={WHATSAPP_HREF}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors hover:decoration-foreground"
              >
                Fale com a gente no WhatsApp
              </a>
              .
            </p>
          </div>
        </section>

        {/* Perguntas: as objeções que aparecem na conversa de venda. */}
        <section id="perguntas" className="mx-auto max-w-3xl px-6 py-20 lg:py-24">
          <h2 className="text-balance font-heading text-3xl font-bold tracking-[-0.03em] sm:text-4xl">
            Perguntas que todo mundo faz antes de assinar
          </h2>

          <div className="mt-10 divide-y divide-border border-y border-border">
            {PERGUNTAS.map((item) => (
              <details key={item.q} className="group py-1">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-left font-heading text-base font-medium text-foreground [&::-webkit-details-marker]:hidden">
                  {item.q}
                  <span
                    aria-hidden="true"
                    className="relative size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                  >
                    <span className="absolute left-0 top-1/2 h-px w-4 -translate-y-1/2 bg-current" />
                    <span className="absolute left-1/2 top-0 h-4 w-px -translate-x-1/2 bg-current transition-transform duration-200 group-open:rotate-90 group-open:opacity-0" />
                  </span>
                </summary>
                <p className="pb-5 pr-8 text-[15px] leading-relaxed text-muted-foreground">
                  {item.a}
                </p>
              </details>
            ))}
          </div>

          <p className="mt-8 text-[15px] text-muted-foreground">
            Ficou com outra dúvida?{' '}
            <a
              href={WHATSAPP_HREF}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors hover:decoration-foreground"
            >
              Chame a gente no WhatsApp
            </a>
            . Quem responde conhece a plataforma.
          </p>
        </section>

        {/* CTA final */}
        <section className="mx-auto max-w-6xl px-6 pb-24">
          <div className="relative overflow-hidden rounded-3xl bg-primary px-6 py-16 text-center text-primary-foreground">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_120%_at_50%_0%,rgba(255,255,255,0.18),transparent_65%)]"
            />
            <div className="relative">
              <h2 className="text-balance font-heading text-3xl font-bold tracking-[-0.03em] sm:text-4xl">
                Conecte seu WhatsApp e veja a IA atendendo hoje
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-lg text-primary-foreground/85">
                7 dias grátis, sem cartão e sem taxa de implantação. Se não fizer
                sentido, é só não continuar.
              </p>
              <a
                href={TRIAL_HREF}
                className="mt-8 inline-flex items-center gap-2 rounded-lg bg-background px-8 py-3.5 text-sm font-semibold text-foreground transition hover:opacity-90"
              >
                Começar teste grátis
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 py-12 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <FluxiaLogo />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted-foreground">
              Atendimento e vendas no WhatsApp, Instagram e Messenger, com
              agentes de IA e funil no mesmo lugar.
            </p>
          </div>

          <div>
            <p className="font-heading text-sm font-semibold">Produto</p>
            <ul className="mt-4 flex flex-col gap-2.5 text-sm">
              {NAV.map((item) => (
                <li key={item.href}>
                  <a
                    href={item.href}
                    className="inline-block py-1 text-muted-foreground transition-colors hover:text-foreground"
                  >
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
                <a
                  href={TRIAL_HREF}
                  className="inline-block py-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  Teste grátis de 7 dias
                </a>
              </li>
              <li>
                <a
                  href="/login"
                  className="inline-block py-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  Entrar na plataforma
                </a>
              </li>
              <li>
                <a
                  href={WHATSAPP_HREF}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block py-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  Falar no WhatsApp
                </a>
              </li>
            </ul>
          </div>

          <div>
            <p className="font-heading text-sm font-semibold">Legal</p>
            <ul className="mt-4 flex flex-col gap-2.5 text-sm">
              <li>
                <a
                  href="/privacidade"
                  className="inline-block py-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  Privacidade
                </a>
              </li>
              <li>
                <a
                  href="/termos"
                  className="inline-block py-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  Termos de uso
                </a>
              </li>
              <li>
                <a
                  href="/exclusao-de-dados"
                  className="inline-block py-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  Exclusão de dados
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-border/60">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 py-5 text-sm text-muted-foreground sm:flex-row">
            <span>© {new Date().getFullYear()} Sales Tecnologia · FluxiaCRM</span>
            <span>Feito para quem vende conversando.</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
