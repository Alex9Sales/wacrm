import { Check, CheckCheck, Search, Sparkles, Plus } from 'lucide-react'

// ============================================================
// Mockups do produto para o site de vendas.
//
// São reconstruções fiéis das telas reais (inbox, funil e agente de
// IA) feitas com os mesmos tokens do app, não capturas de tela: assim
// acompanham o tema claro/escuro, o acento escolhido e o responsivo,
// e não envelhecem a cada release da UI.
//
// Todos são decorativos para leitor de tela (`aria-hidden`): o texto
// que os acompanha na página já descreve o que eles mostram.
// ============================================================

function Avatar({
  initials,
  className = '',
}: {
  initials: string
  className?: string
}) {
  return (
    <span
      className={`flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground ${className}`}
    >
      {initials}
    </span>
  )
}

/** Selinho do canal, no mesmo espírito do ChannelBadge do inbox. */
function ChannelDot({
  channel,
}: {
  channel: 'whatsapp' | 'instagram' | 'messenger' | 'email'
}) {
  if (channel === 'instagram') {
    return (
      <span className="size-2.5 shrink-0 rounded-[3px] bg-[linear-gradient(45deg,#f9ce34,#ee2a7b,#6228d7)]" />
    )
  }
  if (channel === 'messenger') {
    return <span className="size-2.5 shrink-0 rounded-full bg-[#0084ff]" />
  }
  if (channel === 'email') {
    return (
      <span className="size-2.5 shrink-0 rounded-[3px] border border-muted-foreground/70" />
    )
  }
  return <span className="size-2.5 shrink-0 rounded-full bg-emerald-500" />
}

const CONVERSAS = [
  {
    initials: 'CM',
    name: 'Carla Mendes',
    preview: 'Boa noite! Ainda dá pra agendar essa semana?',
    time: '22:14',
    channel: 'whatsapp' as const,
    unread: 2,
    active: true,
  },
  {
    initials: 'RS',
    name: 'Rodrigo Salles',
    preview: 'Comentou "quero" no post do lançamento',
    time: '21:48',
    channel: 'instagram' as const,
    unread: 1,
    active: false,
  },
  {
    initials: 'JP',
    name: 'Juliana Prado',
    preview: 'Perfeito, pode mandar a proposta',
    time: '20:03',
    channel: 'messenger' as const,
    unread: 0,
    active: false,
  },
  {
    initials: 'MT',
    name: 'Marcos Teles',
    preview: 'Recebi o orçamento, obrigado',
    time: '18:27',
    channel: 'email' as const,
    unread: 0,
    active: false,
  },
]

/**
 * Caixa de entrada compartilhada: conversas de vários canais à
 * esquerda, thread à direita com a IA respondendo fora do horário.
 */
export function InboxMockup() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_60px_-24px_rgba(0,0,0,0.55)]"
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span className="font-heading text-sm font-semibold">
          Caixa de entrada
        </span>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
          4 canais
        </span>
        <div className="ml-auto flex items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5">
          <Search className="size-3.5 text-muted-foreground" />
          <span className="text-[11px] text-muted-foreground">Buscar</span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
        <ul className="hidden border-r border-border sm:block">
          {CONVERSAS.map((c) => (
            <li
              key={c.name}
              className={`flex gap-2.5 border-b border-border/60 px-3 py-3 ${
                c.active ? 'bg-primary/[0.07]' : ''
              }`}
            >
              <Avatar initials={c.initials} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <ChannelDot channel={c.channel} />
                  <span className="truncate text-xs font-medium text-foreground">
                    {c.name}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {c.time}
                  </span>
                </div>
                <p className="mt-1 truncate text-[11px] text-muted-foreground">
                  {c.preview}
                </p>
              </div>
              {c.unread > 0 && (
                <span className="mt-4 flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground">
                  {c.unread}
                </span>
              )}
            </li>
          ))}
        </ul>

        <div className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <Avatar initials="CM" className="size-7" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">Carla Mendes</p>
              <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <ChannelDot channel="whatsapp" /> WhatsApp Comercial
              </p>
            </div>
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">
              <Sparkles className="size-3" /> Agente ativo
            </span>
          </div>

          <div className="flex flex-col gap-2.5 px-4 py-4">
            <div className="max-w-[78%] rounded-2xl rounded-tl-sm bg-muted px-3 py-2">
              <p className="text-[11px] leading-relaxed text-foreground">
                Boa noite! Ainda dá pra agendar essa semana?
              </p>
              <span className="mt-1 block text-[9px] text-muted-foreground">
                22:14
              </span>
            </div>

            <div className="max-w-[82%] self-end rounded-2xl rounded-tr-sm bg-primary px-3 py-2">
              <p className="text-[11px] leading-relaxed text-primary-foreground">
                Boa noite, Carla! Dá sim. Tenho quinta às 14h ou sexta às 10h.
                Qual fica melhor pra você?
              </p>
              <span className="mt-1 flex items-center justify-end gap-1 text-[9px] text-primary-foreground/75">
                <Sparkles className="size-2.5" /> Agente IA · 22:14
                <CheckCheck className="size-3" />
              </span>
            </div>

            <div className="max-w-[78%] rounded-2xl rounded-tl-sm bg-muted px-3 py-2">
              <p className="text-[11px] leading-relaxed text-foreground">
                Quinta às 14h, fechado
              </p>
              <span className="mt-1 block text-[9px] text-muted-foreground">
                22:15
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-1.5 self-center rounded-full bg-primary/[0.08] px-3 py-1.5">
              <Check className="size-3 shrink-0 text-primary" />
              <span className="text-[10px] text-muted-foreground">
                Agendado quinta 14h, negócio movido para
              </span>
              <span className="text-[10px] font-medium text-foreground">
                Qualificação
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const ETAPAS = [
  {
    name: 'Novo lead',
    color: '#3b82f6',
    total: 'R$ 18.400',
    cards: [
      {
        title: 'Clínica Vitrale',
        value: 'R$ 4.900',
        initials: 'CV',
        tag: 'Instagram',
      },
      {
        title: 'Ateliê Norte',
        value: 'R$ 2.700',
        initials: 'AN',
        tag: 'WhatsApp',
      },
    ],
  },
  {
    name: 'Contato iniciado',
    color: '#ec4899',
    total: 'R$ 31.200',
    cards: [
      {
        title: 'Studio Prado',
        value: 'R$ 12.000',
        initials: 'JP',
        tag: 'Proposta enviada',
      },
    ],
  },
  {
    name: 'Qualificação',
    color: '#eab308',
    total: 'R$ 47.500',
    cards: [
      {
        title: 'Salles & Cia',
        value: 'R$ 24.000',
        initials: 'RS',
        tag: 'Reunião quinta',
      },
    ],
  },
]

/** Funil de vendas em kanban, com a sugestão da IA em cima de um card. */
export function PipelineMockup() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_60px_-24px_rgba(0,0,0,0.55)]"
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span className="font-heading text-sm font-semibold">
          Funil de vendas
        </span>
        <span className="text-[11px] text-muted-foreground">
          Previsão: R$ 97.100
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3">
        {ETAPAS.map((etapa, i) => (
          <div
            key={etapa.name}
            className={`min-w-0 rounded-xl bg-muted/40 p-2.5 ${
              i === 2 ? 'hidden sm:block' : ''
            }`}
          >
            <div className="flex items-center gap-1.5">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: etapa.color }}
              />
              <span className="truncate text-[11px] font-medium text-foreground">
                {etapa.name}
              </span>
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {etapa.total}
            </p>

            <div className="mt-2.5 flex flex-col gap-2">
              {etapa.cards.map((card) => (
                <div
                  key={card.title}
                  className="rounded-lg border border-border bg-card p-2.5"
                >
                  <p className="truncate text-[11px] font-medium text-foreground">
                    {card.title}
                  </p>
                  <p className="mt-0.5 font-heading text-xs font-semibold text-foreground">
                    {card.value}
                  </p>
                  <div className="mt-2 flex items-center gap-1.5">
                    <Avatar
                      initials={card.initials}
                      className="size-5 text-[8px]"
                    />
                    <span className="truncate rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                      {card.tag}
                    </span>
                  </div>
                </div>
              ))}

              {etapa.name === 'Contato iniciado' && (
                <div className="rounded-lg border border-primary/30 bg-primary/[0.07] p-2.5">
                  <p className="flex items-center gap-1 text-[10px] font-medium text-primary">
                    <Sparkles className="size-3" /> Sugestão da IA
                  </p>
                  <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                    Sem resposta há 4 dias. Reenviar a proposta com o prazo de
                    instalação.
                  </p>
                </div>
              )}

              {etapa.name === 'Novo lead' && (
                <div className="flex items-center gap-1 rounded-lg border border-dashed border-border px-2.5 py-2 text-[10px] text-muted-foreground">
                  <Plus className="size-3" /> Novo negócio
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** O agente de IA sendo configurado: tom, base de conhecimento e limites. */
export function AgentMockup() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_60px_-24px_rgba(0,0,0,0.55)]"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Sparkles className="size-3.5" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">Agente Comercial</p>
          <p className="truncate text-[10px] text-muted-foreground">
            WhatsApp Comercial · Instagram
          </p>
        </div>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-500">
          <span className="size-1.5 rounded-full bg-emerald-500" /> No ar
        </span>
      </div>

      <div className="flex flex-col gap-3.5 p-4">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Tom de voz
          </p>
          <p className="mt-1.5 rounded-lg bg-muted px-3 py-2 text-[11px] leading-relaxed text-foreground">
            Direto e cordial. Trata por você, responde curto e sempre oferece um
            horário no fim da mensagem.
          </p>
        </div>

        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Base de conhecimento
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {['tabela-de-precos.pdf', 'objecoes.md', 'condições de pagamento'].map(
              (item) => (
                <span
                  key={item}
                  className="rounded-md bg-muted px-2 py-1 text-[10px] text-muted-foreground"
                >
                  {item}
                </span>
              )
            )}
          </div>
        </div>

        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            O que ele pode fazer
          </p>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {[
              'Qualificar e marcar o lead na etapa certa',
              'Agendar na agenda conectada',
              'Chamar um humano quando o cliente pedir',
            ].map((item) => (
              <li key={item} className="flex items-start gap-1.5 text-[11px]">
                <Check className="mt-0.5 size-3 shrink-0 text-primary" />
                <span className="text-foreground">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
