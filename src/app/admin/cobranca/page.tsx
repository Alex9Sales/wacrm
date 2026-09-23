// ============================================================
// 💰 /admin/cobranca — Sucesso de Cobrança (23/09, pedido do Rafael):
// "mostrar em números, bem na cara, quanto o cliente está recuperando com a
// ferramenta e quanto está economizando — por dia, mês e conta". É o painel
// que se abre antes de uma renovação: o cliente reclama do preço olhando a
// fatura, não o retorno.
//
// Honestidade (as duas regras de collections-success.ts, repetidas na tela):
//  • Recuperado = pago de verdade (RECEIVED/CONFIRMED) DEPOIS de um toque
//    nosso. O que o cliente pagou sozinho aparece cinza, à parte.
//  • Economia = parcelas avisadas pelo CRM × a taxa que o Asaas cobra por
//    aviso; a API oficial fica fora (lá a Meta cobra a conversa).
// ============================================================
import { redirect } from 'next/navigation'
import Link from 'next/link'

import { requirePlatformAdmin } from '@/lib/auth/platform'
import { UnauthorizedError, ForbiddenError } from '@/lib/auth/account'
import { getCollectionsSuccess, type CollectionsAccountRow } from '@/lib/admin/collections-success'

export const dynamic = 'force-dynamic'

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' | 'muted' }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={`mt-1 text-2xl font-bold ${
          tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'muted' ? 'text-muted-foreground' : 'text-foreground'
        }`}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** Por que a régua não está rendendo nesta conta — o que o CS vai perguntar. */
function ruleNote(a: CollectionsAccountRow): { text: string; tone: string } | null {
  if (!a.ruleEnabled) return { text: 'régua desligada', tone: 'text-red-600 dark:text-red-400' }
  if (!a.autoSend) return { text: 'só sugere (não envia sozinha)', tone: 'text-amber-600 dark:text-amber-400' }
  if (!a.notificationsOff) return { text: 'avisos do Asaas ainda ligados — economia é potencial', tone: 'text-amber-600 dark:text-amber-400' }
  return null
}

export default async function AdminCobrancaPage() {
  try {
    await requirePlatformAdmin()
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect('/login')
    if (err instanceof ForbiddenError) redirect('/dashboard')
    throw err
  }

  const d = await getCollectionsSuccess()
  const porOrg = new Map<string, typeof d.connections>()
  for (const c of d.connections) {
    const list = porOrg.get(c.orgId) ?? []
    list.push(c)
    porOrg.set(c.orgId, list)
  }
  const ordenadas = [...d.accounts].sort((a, b) => b.recovered.month - a.recovered.month || b.openValue - a.openValue)

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-foreground">💰 Sucesso de Cobrança</h1>
          <p className="text-sm text-muted-foreground">
            Quanto cada cliente recuperou com a régua e quanto deixou de pagar ao Asaas. Recuperado = pago de verdade
            (RECEIVED/CONFIRMED) depois de um toque nosso.
          </p>
        </div>
        <Link href="/admin" className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted">
          ← Clientes
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Recuperado hoje" value={brl(d.totals.recoveredToday)} tone="good" hint={`${d.totals.accounts} conta(s) com Asaas ligado`} />
        <Stat label="Recuperado no mês" value={brl(d.totals.recoveredMonth)} tone="good" hint={`desde o início do mês`} />
        <Stat
          label="Economia no Asaas (mês)"
          value={brl(d.totals.savingsMonthBrl)}
          tone="good"
          hint={`${d.totals.savingsMonthCount} parcela(s) avisada(s) pelo CRM${d.totals.officialMonth > 0 ? ` · ${d.totals.officialMonth} pela API oficial (fora da conta)` : ''}`}
        />
        <Stat label="Ainda vencido na carteira" value={brl(d.totals.openValue)} hint="o que a régua ainda tem para trazer" />
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <p className="text-sm font-semibold text-foreground">Por cliente</p>
          <p className="text-xs text-muted-foreground">
            Ordenado pelo que recuperou no mês. &ldquo;Sem toque&rdquo; = o cliente pagou sem a régua ter falado — fica à parte de propósito.
          </p>
        </div>
        {ordenadas.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Nenhuma conta com Asaas conectado ainda.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Cliente</th>
                  <th className="px-4 py-2 text-right font-medium">Recuperado hoje</th>
                  <th className="px-4 py-2 text-right font-medium">Recuperado no mês</th>
                  <th className="px-4 py-2 text-right font-medium">Economia hoje</th>
                  <th className="px-4 py-2 text-right font-medium">Economia no mês</th>
                  <th className="px-4 py-2 text-right font-medium">Vencido em aberto</th>
                </tr>
              </thead>
              <tbody>
                {ordenadas.map((a) => {
                  const nota = ruleNote(a)
                  const contas = porOrg.get(a.orgId) ?? []
                  return (
                    <tr key={a.orgId} className="border-b border-border/60 align-top last:border-0">
                      <td className="px-4 py-2.5">
                        <p className="font-medium text-foreground">{a.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {a.connections.length ? a.connections.join(' · ') : 'sem conta ligada'}
                          {a.recoveredNoTouch.month > 0 ? ` · ${brl(a.recoveredNoTouch.month)} sem toque no mês` : ''}
                        </p>
                        {nota ? <p className={`text-xs ${nota.tone}`}>{nota.text}</p> : null}
                        {contas.length > 1 ? (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {contas
                              .map((c) => `${c.label}: ${brl(c.recoveredMonth)} recuperado · ${brl(c.savingsMonthBrl)} economizado`)
                              .join(' · ')}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {a.recovered.today > 0 ? <span className="font-medium text-emerald-600 dark:text-emerald-400">{brl(a.recovered.today)}</span> : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {a.recovered.month > 0 ? <span className="font-medium text-emerald-600 dark:text-emerald-400">{brl(a.recovered.month)}</span> : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                        {a.savings.todayCount > 0 ? `${brl(a.savings.todayBrl)} · ${a.savings.todayCount}` : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                        {a.savings.monthCount > 0 ? `${brl(a.savings.monthBrl)} · ${a.savings.monthCount}` : '—'}
                        {a.officialMonth > 0 ? <span className="block text-[11px]">+{a.officialMonth} oficial</span> : null}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {a.openCount > 0 ? (
                          <>
                            {brl(a.openValue)}
                            <span className="block text-[11px] text-muted-foreground">{a.openCount} parcela(s)</span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Como o número é feito: <b>recuperado</b> soma as parcelas que o Asaas marcou como pagas (RECEIVED/CONFIRMED) e que tiveram uma
        cobrança nossa enviada nos 45 dias antes de saírem da carteira — parcela apagada no Asaas nunca entra. <b>Economia</b> conta
        parcelas avisadas pelo CRM (o Asaas cobra por cobrança, não por mensagem) × a taxa configurada em Cobranças → Ajustar, e só vale de
        fato com &ldquo;O CRM assume os avisos&rdquo; ligado. Envio pela API oficial fica fora: lá quem cobra a conversa é a Meta.
      </p>
    </div>
  )
}
