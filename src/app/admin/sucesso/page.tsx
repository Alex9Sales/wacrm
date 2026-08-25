// ============================================================
// /admin/sucesso — painel de Sucesso do Cliente (framework do Rafael, 4
// camadas). Server component; platform-admin only. Honestidade: o que
// depende do gateway em produção fica no box "ainda não dá pra medir",
// e o Health Score carrega o aviso de calibração.
// ============================================================
import { redirect } from 'next/navigation'
import Link from 'next/link'

import { requirePlatformAdmin } from '@/lib/auth/platform'
import { UnauthorizedError, ForbiddenError } from '@/lib/auth/account'
import { getSuccessDashboard, type AccountHealthRow } from '@/lib/admin/success'

export const dynamic = 'force-dynamic'

function brl(v: number): string {
  return `R$ ${v.toLocaleString('pt-BR')}`
}

function HealthBadge({ health }: { health: number }) {
  const tone =
    health >= 70
      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
      : health >= 40
        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
        : 'bg-red-500/15 text-red-600 dark:text-red-400'
  return (
    <span className={`inline-flex min-w-[42px] justify-center rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {health}
    </span>
  )
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold text-foreground">{value}</p>
      {hint ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

function MiniList({
  title,
  empty,
  rows,
  detail,
}: {
  title: string
  empty: string
  rows: AccountHealthRow[]
  detail: (r: AccountHealthRow) => string
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-sm font-semibold text-foreground">
        {title} ({rows.length})
      </p>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {rows.map((r) => (
            <li
              key={r.orgId}
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm"
            >
              <HealthBadge health={r.health} />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {r.name}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {detail(r)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default async function AdminSucessoPage() {
  try {
    await requirePlatformAdmin()
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect('/login')
    if (err instanceof ForbiddenError) redirect('/dashboard')
    throw err
  }

  const d = await getSuccessDashboard()
  const conv = (n: number, base: number) =>
    base > 0 ? ` (${Math.round((n / base) * 100)}%)` : ''

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-foreground">
            📈 Sucesso do Cliente
          </h1>
          <p className="text-sm text-muted-foreground">
            Dinheiro → risco → operação → expansão. O cancelamento se decide
            nos primeiros 30 dias — este painel olha pra lá.
          </p>
        </div>
        <Link
          href="/admin"
          className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
        >
          ← Clientes
        </Link>
      </div>

      {/* 1) Dinheiro */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="MRR contratado"
          value={brl(d.money.mrr)}
          hint={`${d.money.activeCount} assinante(s) ativo(s)`}
        />
        <Stat
          label="Em teste"
          value={brl(d.money.trialMrr)}
          hint={`${d.money.trialCount} conta(s), se converter tudo`}
        />
        <Stat
          label="Novos no mês"
          value={String(d.money.newThisMonth)}
          hint="contas provisionadas"
        />
        <Stat
          label="Perdido no mês"
          value={d.money.canceledThisMonth > 0 ? brl(d.money.churnedMrr) : '—'}
          hint={
            d.money.canceledThisMonth > 0
              ? `${d.money.canceledThisMonth} cancelamento(s)${
                  d.money.churnRate !== null
                    ? ` · churn ${(d.money.churnRate * 100).toFixed(1)}%`
                    : ''
                }`
              : 'nenhum cancelamento'
          }
        />
      </div>

      {/* 2) Ativação — onde o cliente novo para */}
      <div>
        <p className="mb-2 text-sm font-semibold text-foreground">
          Onde o cliente novo para — o cancelamento se decide aqui
          <span className="ml-2 font-normal text-muted-foreground">
            (contas dos últimos 90 dias
            {d.activation.ttvMedianDays !== null
              ? ` · mediana até o 1º negócio: ${d.activation.ttvMedianDays} dia(s)`
              : ''}
            )
          </span>
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Criou conta" value={String(d.activation.created)} />
          <Stat
            label="Conectou canal"
            value={`${d.activation.withChannel}${conv(d.activation.withChannel, d.activation.created)}`}
          />
          <Stat
            label="Tem contato"
            value={`${d.activation.withContact}${conv(d.activation.withContact, d.activation.created)}`}
          />
          <Stat
            label="1º negócio no funil"
            value={`${d.activation.withDeal}${conv(d.activation.withDeal, d.activation.created)}`}
            hint="o “primeiro resultado”"
          />
        </div>
      </div>

      {/* 2b) Aha Moment — TTV do VALOR CENTRAL (1ª resposta real da IA).
          "Usar o CRM" (inbox humano) ≠ "experimentar o que diferencia a
          Fluxia" — daí a métrica separada da ativação operacional. */}
      <div>
        <p className="mb-2 text-sm font-semibold text-foreground">
          ⚡ Aha Moment — 1ª resposta da IA{' '}
          <span className="font-normal text-muted-foreground">
            (meta: ≥70% das contas novas em até 48h · mediana &lt; 30min)
          </span>
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat
            label="Chegaram ao Aha em 48h"
            value={d.aha.rate48h !== null ? `${d.aha.rate48h}%` : '—'}
            hint={`${d.aha.activated} de ${d.aha.total} contas alguma vez`}
          />
          <Stat
            label="Mediana criação → IA responder"
            value={
              d.aha.medianTtvHours !== null
                ? d.aha.medianTtvHours >= 48
                  ? `${Math.round(d.aha.medianTtvHours / 24)} dias`
                  : `${Math.round(d.aha.medianTtvHours)}h`
                : '—'
            }
            hint="entre as que chegaram lá"
          />
          <Stat
            label="IA nunca respondeu (+48h de vida)"
            value={String(d.aha.neverActivated.length)}
            hint="alerta operacional: agir manualmente"
          />
        </div>
        {d.aha.neverActivated.length > 0 && (
          <div className="mt-3">
            <MiniList
              title="🔕 Nunca ativaram a IA — ligar/zap/onboarding assistido"
              empty=""
              rows={d.aha.neverActivated}
              detail={(r) =>
                `${r.msgs7d > 0 ? 'usa como inbox humano' : r.channels > 0 ? 'canal ligado, IA não' : 'nem canal conectou'} · conta de ${new Date(r.createdAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`
              }
            />
          </div>
        )}
      </div>

      {/* 3) Fila de atenção + expansão */}
      <div className="grid gap-3 lg:grid-cols-2">
        <MiniList
          title="🚨 Agir agora"
          empty="nenhuma conta em risco"
          rows={d.actNow}
          detail={(r) =>
            r.idleDays !== null && r.idleDays >= 14
              ? `parado há ${r.idleDays}d`
              : `saúde ${r.health}`
          }
        />
        <MiniList
          title="📈 Prontos para upgrade"
          empty="ninguém perto do limite ainda"
          rows={d.upgradeReady}
          detail={(r) => `${r.msgs7d} msg/7d · ${r.modules}/${r.modulesTotal} módulos`}
        />
      </div>

      {/* 4) Saúde por conta */}
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Cliente</th>
              <th className="px-2 py-2.5 font-medium">Saúde</th>
              <th className="px-2 py-2.5 font-medium">Plano</th>
              <th className="px-2 py-2.5 text-right font-medium">Até 1º negócio</th>
              <th className="px-2 py-2.5 text-right font-medium">Módulos</th>
              <th className="px-2 py-2.5 text-right font-medium">Msg 7d</th>
              <th className="px-2 py-2.5 text-right font-medium">Usuários 7d</th>
              <th className="px-2 py-2.5 text-right font-medium">Contatos</th>
              <th className="px-2 py-2.5 text-right font-medium">Chamados</th>
              <th className="px-4 py-2.5 text-right font-medium">Parado</th>
            </tr>
          </thead>
          <tbody>
            {d.accounts.length === 0 ? (
              <tr>
                <td
                  colSpan={10}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  nenhum cliente ainda
                </td>
              </tr>
            ) : (
              d.accounts.map((r) => (
                <tr key={r.orgId} className="border-b border-border/60 last:border-0">
                  <td className="max-w-[220px] truncate px-4 py-2 font-medium text-foreground">
                    {r.name}
                  </td>
                  <td className="px-2 py-2">
                    <HealthBadge health={r.health} />
                  </td>
                  <td className="px-2 py-2 text-muted-foreground">
                    {r.plan ?? '—'}
                    {r.status === 'trial' ? ' (teste)' : ''}
                  </td>
                  <td className="px-2 py-2 text-right text-muted-foreground">
                    {r.ttvDays !== null ? `${r.ttvDays}d` : '—'}
                  </td>
                  <td className="px-2 py-2 text-right text-muted-foreground">
                    {r.modules}/{r.modulesTotal}
                  </td>
                  <td className="px-2 py-2 text-right text-muted-foreground">
                    {r.msgs7d}
                  </td>
                  <td className="px-2 py-2 text-right text-muted-foreground">
                    {r.activeUsers7d}
                  </td>
                  <td className="px-2 py-2 text-right text-muted-foreground">
                    {r.contacts}
                  </td>
                  <td className="px-2 py-2 text-right text-muted-foreground">
                    {r.ticketsOpen > 0 ? r.ticketsOpen : '—'}
                  </td>
                  <td className="px-4 py-2 text-right text-muted-foreground">
                    {r.idleDays !== null ? `${r.idleDays}d` : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Honestidade metodológica */}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <p className="font-semibold text-amber-700 dark:text-amber-400">
            Health Score ainda não calibrado
          </p>
          <p className="mt-1.5 leading-relaxed text-amber-700/90 dark:text-amber-400/90">
            Os pesos (ativação 30, frequência 25, profundidade 20, volume 15,
            pagamento 10) são uma hipótese, não um modelo validado. Pra
            calibrar de verdade: pegar quem cancelou e ver que nota essas
            contas tinham 60 dias antes de sair. Enquanto não houver esse
            histórico, use a nota pra ordenar a fila de atenção — não pra
            decidir sozinha.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 text-sm">
          <p className="font-semibold text-foreground">
            O que ainda não dá para medir
          </p>
          <ul className="mt-1.5 space-y-1.5 text-muted-foreground">
            <li>
              <strong className="text-foreground">NRR e churn de receita recebida</strong>{' '}
              — dependem do Asaas em produção confirmando cobrança; aqui é o
              contratado. O histórico pro NRR começa a acumular agora.
            </li>
            <li>
              <strong className="text-foreground">Churn involuntário (cartão recusado)</strong>{' '}
              — só existe com o gateway ligado; quando entrar, separa quem
              decidiu sair de quem só teve o cartão recusado.
            </li>
            <li>
              <strong className="text-foreground">NPS</strong> — chamados e
              tempo de resposta já vêm do /suporte embutido (coluna Chamados);
              NPS precisa de pesquisa própria.
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}
