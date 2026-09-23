'use client'

// ============================================================
// 📮 Envios da régua — uma faixa, não uma parede de quadradinhos.
//
// Pedido do Alex (17/09): "quantos vai enviar no dia, quantos enviou, quantos
// no mês e o que teve de resposta — com a auditoria e o ícone de conversa pra
// clicar e conferir se a mensagem chegou". A tela da carteira já tem cinco
// cartões em cima; mais cinco viraria ruído. Então: UMA linha que se lê de
// ponta a ponta, e a auditoria fechada por baixo, que abre quando o dono quer
// conferir de fato.
//
// A auditoria abre a conversa pelo ícone (/inbox?c=…) — é o jeito do dono
// checar com os próprios olhos se a mensagem chegou, que foi o pedido.
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ChevronDown,
  ChevronRight,
  Mail,
  MessageSquare,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react'

import { getSendsReport, type SendsReport } from '@/app/(dashboard)/cobrancas/actions'
import { sendOutcome } from '@/lib/collections/send-status'

const fmtHora = (iso: string | null, tz: string) =>
  iso
    ? new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(
        new Date(iso),
      )
    : null

const TOM: Record<'ok' | 'bom' | 'espera' | 'ruim', string> = {
  ok: 'text-muted-foreground',
  bom: 'text-emerald-600 dark:text-emerald-400',
  espera: 'text-amber-600 dark:text-amber-400',
  ruim: 'text-red-600 dark:text-red-400',
}

export function SendsPanel({ timezone = 'America/Sao_Paulo' }: { timezone?: string }) {
  const router = useRouter()
  const [data, setData] = useState<SendsReport | null>(null)
  const [aberto, setAberto] = useState(false)
  const [carregando, setCarregando] = useState(false)

  const carregar = useCallback(async () => {
    setCarregando(true)
    try {
      setData(await getSendsReport())
    } catch {
      /* painel de leitura: erro não derruba a carteira */
    } finally {
      setCarregando(false)
    }
  }, [])

  useEffect(() => {
    void carregar()
  }, [carregar])

  if (!data) return null

  const { today, month, rows, savings } = data
  const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  const inicio = fmtHora(today.firstAt, timezone)
  const fim = fmtHora(today.lastAt, timezone)
  const nadaHoje = today.sent === 0 && today.waiting === 0 && today.failed === 0

  return (
    <section className="rounded-xl border border-border bg-card">
      {/* A faixa: lê-se da esquerda pra direita como uma frase. */}
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums leading-none">{today.sent}</span>
          <span className="text-sm text-muted-foreground">
            {today.sent === 1 ? 'cobrança enviada hoje' : 'cobranças enviadas hoje'}
          </span>
          {inicio && fim && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {inicio === fim ? `· ${inicio}` : `· ${inicio} às ${fim}`}
            </span>
          )}
        </div>

        {today.delivered > 0 && (
          <span className="text-sm text-muted-foreground">
            <b className="font-semibold tabular-nums text-foreground">{today.delivered}</b> chegaram no aparelho
          </span>
        )}
        {today.replied > 0 && (
          <span className="text-sm text-emerald-600 dark:text-emerald-400">
            <b className="font-semibold tabular-nums">{today.replied}</b> responderam
          </span>
        )}
        {today.waiting > 0 && (
          <span className="text-sm text-amber-600 dark:text-amber-400">
            <b className="font-semibold tabular-nums">{today.waiting}</b> ainda na fila
          </span>
        )}
        {(today.failed > 0 || today.expired > 0) && (
          <span className="inline-flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400">
            <TriangleAlert className="h-3.5 w-3.5" />
            <b className="font-semibold tabular-nums">{today.failed + today.expired}</b>{' '}
            {today.failed > 0 ? 'falharam' : 'não saíram'}
          </span>
        )}
        {nadaHoje && <span className="text-sm text-muted-foreground">Nada saiu hoje ainda.</span>}

        <span className="ml-auto text-xs text-muted-foreground">
          No mês: <b className="tabular-nums text-foreground">{month.sent}</b>{' '}
          {month.sent === 1 ? 'cobrança' : 'cobranças'} para{' '}
          <b className="tabular-nums text-foreground">{month.clients}</b>{' '}
          {month.clients === 1 ? 'cliente' : 'clientes'}
          {month.repliedClients > 0 && (
            <>
              {' · '}
              <b className="tabular-nums text-foreground">{month.repliedClients}</b>{' '}
              {month.repliedClients === 1 ? 'respondeu' : 'responderam'}
            </>
          )}
          {/* Sem "não saíram" do mês de propósito (17/09, João): rascunho que
              expira é a régua REFAZENDO no dia seguinte, não cliente sem
              cobrança. Dos 70 da GoLink, 46 eram de gente cobrada em outro dia —
              o número levava a crer que 70 pessoas ficaram sem cobrar. */}
        </span>
      </div>

      {/* 💰 Economia no Asaas (23/09, ideia do Rafael): bem na cara — o cliente
          vê quanto deixou de pagar ao Asaas antes de reclamar do CRM. */}
      {(savings.month.count > 0 || savings.officialMonth > 0) && (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-sm">
          <span className="font-medium text-emerald-700 dark:text-emerald-400">
            Economia no Asaas: {brl(savings.month.brl)} no mês
          </span>
          <span className="text-xs text-muted-foreground">
            {savings.month.count} {savings.month.count === 1 ? 'aviso de cobrança saiu' : 'avisos de cobrança saíram'} pelo CRM
            {savings.month.whatsapp > 0 || savings.month.email > 0
              ? ` (${savings.month.whatsapp} no WhatsApp a ${brl(savings.fee)} · ${savings.month.email} por e-mail a ${brl(savings.emailFee)})`
              : ''}
            {savings.today.count > 0 ? ` · hoje ${savings.today.count} (${brl(savings.today.brl)})` : ''}
            {' · estimativa'}
          </span>
          {savings.byConnection.length > 1 && (
            <span className="text-xs text-muted-foreground">
              {savings.byConnection
                .map((c) => `${c.label}: ${brl(c.brl)} no mês${c.today.count > 0 ? ` · hoje ${brl(c.today.brl)}` : ''}`)
                .join(' · ')}
            </span>
          )}
          {savings.officialMonth > 0 && (
            <span className="text-xs text-muted-foreground">
              + {savings.officialMonth} pela API oficial (a Meta cobra a conversa — fora da conta)
            </span>
          )}
          {!savings.notificationsOff && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              Estimativa: o Asaas ainda manda (e cobra) os avisos dele — ligue &ldquo;O CRM assume os avisos&rdquo; em Ajustar.
            </span>
          )}
        </div>
      )}

      {/* Auditoria: fechada por padrão. Quem quer conferir, abre. */}
      <div className="flex items-center gap-2 border-t border-border px-4 py-2">
        <button
          type="button"
          onClick={() => setAberto((v) => !v)}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          aria-expanded={aberto}
        >
          {aberto ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Conferir uma por uma
          <span className="font-normal text-muted-foreground">({rows.length})</span>
        </button>
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
        <div className="max-h-96 overflow-y-auto border-t border-border">
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              Nenhuma cobrança saiu hoje ainda.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((r) => {
                // A situação é a do WhatsApp quando houve WhatsApp: é o único
                // canal que sabe dizer se chegou. Só e-mail → fica em "enviada".
                const wa = r.channels.find((c) => c.channel === 'whatsapp')
                const st = sendOutcome({ status: r.status, delivery: (wa ?? r.channels[0])?.delivery ?? null })
                return (
                  <li key={r.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <span className="w-11 shrink-0 tabular-nums text-xs text-muted-foreground">
                      {fmtHora(r.at, timezone)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{r.name}</span>
                    {r.replied && (
                      <span className="shrink-0 text-xs text-emerald-600 dark:text-emerald-400">respondeu</span>
                    )}
                    <span className={`w-20 shrink-0 text-right text-xs ${TOM[st.tom]}`} title={r.error ?? undefined}>
                      {st.texto}
                    </span>
                    {/* Um ícone por canal por onde saiu — quem tem e-mail e
                        WhatsApp recebe nos dois, e os dois abrem a conversa. */}
                    <span className="flex w-16 shrink-0 justify-end gap-0.5">
                      {r.channels.length === 0 && <span className="h-7 w-7" aria-hidden />}
                      {r.channels.map((c) => {
                        const alvo = c.conversationId ?? r.conversationId
                        const Icone = c.channel === 'email' ? Mail : MessageSquare
                        const rotulo =
                          c.channel === 'email' ? 'Abrir o e-mail deste cliente' : 'Abrir a conversa no WhatsApp'
                        return alvo ? (
                          <button
                            key={c.channel}
                            type="button"
                            onClick={() => router.push(`/inbox?c=${alvo}`)}
                            title={rotulo}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-primary transition-colors hover:bg-primary/10"
                          >
                            <Icone className="h-4 w-4" />
                          </button>
                        ) : (
                          <span
                            key={c.channel}
                            title={rotulo}
                            className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground"
                          >
                            <Icone className="h-4 w-4" />
                          </span>
                        )
                      })}
                    </span>
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
