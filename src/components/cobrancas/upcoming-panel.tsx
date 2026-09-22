'use client'

// ============================================================
// 🔔 Próximos vencimentos — o que vence de hoje em diante, por cliente.
//
// João/GoLink (21/09): "entrei no Fluxia e não achei uma cliente". A parcela
// dela ainda não tinha vencido, e a carteira só mostra o VENCIDO. Esta faixa
// mostra o que vem: hoje, esta semana, o horizonte inteiro — com o contato
// do CRM quando há e a conversa para abrir. Só leitura do retrato que a
// varredura grava (collections_upcoming); não bate no Asaas.
//
// Mesma casca fechada por baixo do painel de envios: a faixa se lê como uma
// frase, a lista abre quando o dono quer olhar um por um.
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronRight, ExternalLink, MessageSquare, RefreshCw, TriangleAlert, UserX } from 'lucide-react'

import { getUpcomingCharges, type UpcomingChargesView, type UpcomingCustomerCard } from '@/app/(dashboard)/cobrancas/actions'

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

/** "2026-09-25" → "25/09" — a data como o dono lê no boleto. */
const fmtDia = (key: string | null) => (key ? `${key.slice(8, 10)}/${key.slice(5, 7)}` : '—')

const fmtHora = (iso: string | null, tz: string) =>
  iso
    ? new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(
        new Date(iso),
      )
    : null

/** "5512900001234" → "(12) 90000-1234". O que não for número BR sai como veio. */
function fmtPhone(raw: string): string {
  const d = raw.replace(/\D/g, '')
  const local = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`
  return raw
}

function venceEm(days: number | null): { text: string; tone: string } {
  if (days == null) return { text: 'sem data', tone: 'text-muted-foreground' }
  if (days === 0) return { text: 'vence hoje', tone: 'text-amber-600 dark:text-amber-500' }
  if (days === 1) return { text: 'vence amanhã', tone: 'text-amber-600 dark:text-amber-500' }
  if (days <= 7) return { text: `vence em ${days}d`, tone: 'text-foreground' }
  return { text: `vence em ${days}d`, tone: 'text-muted-foreground' }
}

type Filtro = 'todos' | 'hoje' | 'semana' | 'sem_contato'

function passaFiltro(c: UpcomingCustomerCard, f: Filtro): boolean {
  if (f === 'todos') return true
  if (f === 'sem_contato') return !c.contactId
  if (f === 'hoje') return c.lines.some((l) => l.daysUntil === 0)
  return c.lines.some((l) => l.daysUntil != null && l.daysUntil >= 0 && l.daysUntil <= 7)
}

export function UpcomingPanel({ timezone = 'America/Sao_Paulo', reloadKey = 0 }: { timezone?: string; reloadKey?: number }) {
  const router = useRouter()
  const [data, setData] = useState<UpcomingChargesView | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [aberto, setAberto] = useState(false)
  const [filtro, setFiltro] = useState<Filtro>('todos')
  const [busca, setBusca] = useState('')
  const [carregando, setCarregando] = useState(false)

  const carregar = useCallback(async () => {
    setCarregando(true)
    try {
      const r = await getUpcomingCharges()
      if (r.ok && r.data) {
        setData(r.data)
        setErro(null)
      } else {
        // Painel de leitura: erro não derruba a carteira, mas nunca vira "lista vazia".
        setErro(r.error ?? 'Não deu para carregar os próximos vencimentos.')
      }
    } catch {
      setErro('Não deu para carregar os próximos vencimentos.')
    } finally {
      setCarregando(false)
    }
  }, [])

  useEffect(() => {
    void carregar()
  }, [carregar, reloadKey])

  if (erro && !data) {
    return (
      <section className="flex items-center gap-2 rounded-xl border border-red-600/40 bg-card px-4 py-3 text-sm text-red-600 dark:text-red-400">
        <TriangleAlert className="h-4 w-4 shrink-0" />
        {erro}
        <button type="button" onClick={() => void carregar()} className="ml-auto text-xs underline underline-offset-2">
          tentar de novo
        </button>
      </section>
    )
  }
  if (!data) return null

  const { totals, cards } = data
  const q = busca.trim().toLowerCase()
  const digitos = busca.replace(/\D/g, '')
  const visiveis = cards.filter(
    (c) =>
      passaFiltro(c, filtro) &&
      (!q ||
        c.name.toLowerCase().includes(q) ||
        (c.email ?? '').toLowerCase().includes(q) ||
        // 🐛 guarda: sem dígitos, `includes('')` casaria com todo mundo.
        (digitos.length >= 3 && (c.phone ?? '').replace(/\D/g, '').includes(digitos))),
  )
  const lido = fmtHora(data.checkedAt, timezone)

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums leading-none">{totals.charges}</span>
          <span className="text-sm text-muted-foreground">
            {totals.charges === 1 ? 'parcela a vencer' : 'parcelas a vencer'} nos próximos {data.horizonDays} dias
          </span>
          {totals.value > 0 && <span className="text-xs tabular-nums text-muted-foreground">· {brl(totals.value)}</span>}
        </div>
        {totals.today > 0 && (
          <span className="text-sm text-amber-600 dark:text-amber-400">
            <b className="font-semibold tabular-nums">{totals.today}</b> {totals.today === 1 ? 'vence hoje' : 'vencem hoje'}
          </span>
        )}
        {totals.week > 0 && (
          <span className="text-sm text-muted-foreground">
            <b className="font-semibold tabular-nums text-foreground">{totals.week}</b> nesta semana
          </span>
        )}
        {totals.noContact > 0 && (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <UserX className="h-3.5 w-3.5" />
            <b className="font-semibold tabular-nums text-foreground">{totals.noContact}</b> sem contato no CRM
          </span>
        )}
        {totals.charges === 0 && (
          <span className="text-sm text-muted-foreground">
            {data.checkedAt ? 'Nada a vencer no horizonte.' : 'Ainda não li o Asaas — clique em Atualizar.'}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {data.dueTodayEnabled ? 'Aviso no dia do vencimento ligado' : 'Aviso no dia do vencimento desligado'}
          {data.reminderDaysBefore > 0 ? ` · lembrete ${data.reminderDaysBefore}d antes` : ''}
          {lido ? ` · lido ${lido}` : ''}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2">
        <button
          type="button"
          onClick={() => setAberto((v) => !v)}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          aria-expanded={aberto}
        >
          {aberto ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Ver por cliente
          <span className="font-normal text-muted-foreground">({totals.customers})</span>
        </button>
        {aberto && (
          <>
            <div className="ml-2 flex flex-wrap gap-1">
              {(
                [
                  ['todos', 'Todos'],
                  ['hoje', 'Hoje'],
                  ['semana', '7 dias'],
                  ['sem_contato', 'Sem contato'],
                ] as [Filtro, string][]
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFiltro(k)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                    filtro === k ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar nome, telefone ou e-mail"
              className="h-7 min-w-[12rem] flex-1 rounded-md border border-border bg-background px-2 text-xs"
            />
          </>
        )}
        <button
          type="button"
          onClick={() => void carregar()}
          disabled={carregando}
          title="Atualizar"
          className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${carregando ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {aberto && (
        <div className="max-h-[32rem] overflow-y-auto border-t border-border">
          {visiveis.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              {cards.length === 0 ? 'Nenhuma parcela a vencer no horizonte.' : 'Ninguém com esse filtro.'}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {visiveis.map((c) => {
                const v = venceEm(c.nextDaysUntil)
                return (
                  <li key={`${c.connectionId}:${c.customerId}`} className="px-4 py-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                      <span className={`shrink-0 text-xs ${v.tone}`}>{v.text}</span>
                      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                        {c.lines.length === 1 ? '1 parcela' : `${c.lines.length} parcelas`} · {brl(c.total)}
                      </span>
                      <span className="flex w-16 shrink-0 justify-end gap-0.5">
                        {c.conversationId ? (
                          <button
                            type="button"
                            onClick={() => router.push(`/inbox?c=${c.conversationId}`)}
                            title="Abrir a conversa"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-primary transition-colors hover:bg-primary/10"
                          >
                            <MessageSquare className="h-4 w-4" />
                          </button>
                        ) : c.contactId ? (
                          <span className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground" title="Contato no CRM, sem conversa ainda">
                            <MessageSquare className="h-4 w-4" />
                          </span>
                        ) : (
                          <span className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground" title="Sem contato no CRM">
                            <UserX className="h-4 w-4" />
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      <span>{c.connectionLabel}</span>
                      {c.phone && <span className="tabular-nums">{fmtPhone(c.phone)}</span>}
                      {c.email && <span className="truncate">{c.email}</span>}
                      {!c.contactId && <span className="text-amber-600 dark:text-amber-500">sem contato no CRM — não recebe aviso</span>}
                      {c.onHold && <span className="text-amber-600 dark:text-amber-500">cobrança parada neste cliente</span>}
                    </div>
                    {c.lines.length > 0 && (
                      <ul className="mt-1 flex flex-col gap-0.5 text-xs">
                        {c.lines.map((l) => {
                          const lv = venceEm(l.daysUntil)
                          return (
                            <li key={l.asaasId} className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                              <span className="tabular-nums text-foreground">{brl(l.value)}</span>
                              <span>· {fmtDia(l.dueDate)}</span>
                              <span className={lv.tone}>({lv.text})</span>
                              {l.description && <span className="truncate">· {l.description}</span>}
                              {l.invoiceUrl && (
                                <a
                                  href={l.invoiceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-0.5 text-primary underline-offset-2 hover:underline"
                                  title="Abrir o boleto/link no Asaas"
                                >
                                  <ExternalLink className="h-3 w-3" /> link
                                </a>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
