'use client'

// ============================================================
// 📊 Resultados de uma cadência — a escada, degrau a degrau.
//
// Mora DENTRO da cadência, não numa tela de relatórios: o ajuste acontece
// onde se edita o texto, e ver "este degrau não trouxe resposta" ao lado da
// mensagem que se vai reescrever é o que fecha o ciclo.
//
// A leitura vem antes dos números de propósito. Métrica que não vira decisão
// é enfeite — o operador precisa ler "do 4º em diante ninguém respondeu",
// não somar cinco barras de cabeça.
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Sparkles, TriangleAlert } from 'lucide-react'

import { getCadenceResults } from '@/app/(dashboard)/automations/cadencias/actions'
// O tipo vem da lib, não da action: 'use server' só exporta função async.
import type { CadenceFunnel } from '@/lib/cadences/metrics'

function pct(n: number): string {
  return `${(n * 100).toFixed(n >= 0.1 ? 0 : 1).replace('.', ',')}%`
}

/** "3 mensagens" / "1 mensagem" — plural que não vira "1 mensagens". */
function plural(n: number, um: string, muitos: string): string {
  return `${n} ${n === 1 ? um : muitos}`
}

export function CadenceResults({ cadenceId }: { cadenceId: string }) {
  const [data, setData] = useState<CadenceFunnel | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    void getCadenceResults(cadenceId)
      .then((d) => setData(d))
      .finally(() => setLoading(false))
  }, [cadenceId])

  useEffect(() => {
    load()
  }, [load])

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Lendo os envios…
      </div>
    )
  }
  if (!data) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Não consegui ler os resultados desta cadência.
      </p>
    )
  }

  // Ninguém entrou ainda: número nenhum ajuda, e barra vazia dá impressão de
  // fracasso em vez de "ainda não começou".
  if (data.enrolled === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Ninguém entrou nesta cadência ainda. Assim que os primeiros toques
        saírem, aqui aparece onde cada pessoa respondeu.
      </p>
    )
  }

  const maiorEnvio = Math.max(1, ...data.steps.map((s) => s.sent))

  return (
    <div className="space-y-5">
      {data.reading && (
        <div
          className={`flex gap-3 rounded-xl border p-4 ${
            data.reading.kind === 'no_replies' || data.reading.kind === 'dead_tail'
              ? 'border-amber-500/40 bg-amber-500/5'
              : 'border-primary/30 bg-primary/5'
          }`}
        >
          {data.reading.kind === 'no_replies' || data.reading.kind === 'dead_tail' ? (
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-amber-600" />
          ) : (
            <Sparkles className="mt-0.5 size-5 shrink-0 text-primary" />
          )}
          <div className="space-y-1">
            <p className="font-semibold text-foreground">{data.reading.headline}</p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {data.reading.detail}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Numero rotulo="Entraram" valor={data.enrolled} nota={`${data.running} ainda rodando`} />
        <Numero
          rotulo="Responderam"
          valor={data.replied}
          nota={data.enrolled ? `${pct(data.replied / data.enrolled)} de quem entrou` : ''}
          tom="bom"
        />
        <Numero
          rotulo="Terminaram em silêncio"
          valor={data.finishedSilent}
          nota="passaram por todos os degraus"
        />
        <Numero
          rotulo="Não chegaram a rodar"
          valor={data.neverRan}
          nota="sem canal ou campo exigido"
          tom={data.neverRan > 0 ? 'atencao' : undefined}
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-baseline gap-3 border-b border-border px-5 py-3.5">
          <h3 className="text-sm font-semibold text-foreground">Degrau a degrau</h3>
          <span className="text-xs text-muted-foreground">
            onde cada pessoa respondeu — e onde a régua para de render
          </span>
        </div>

        {data.steps.map((s) => {
          const morto = s.sent > 0 && s.replied === 0
          const corte =
            data.reading?.cutFrom !== undefined && s.degree >= data.reading.cutFrom
          return (
            <div
              key={s.degree}
              className={`flex gap-4 border-b border-border/60 px-5 py-4 last:border-0 ${
                corte ? 'bg-amber-500/5' : ''
              }`}
            >
              <span
                className={`flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold tabular-nums ${
                  s.replied > 0
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                    : morto
                      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-500'
                      : 'bg-muted text-muted-foreground'
                }`}
              >
                {s.degree}
              </span>

              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  {/* A barra compara com o degrau que mais enviou: a queda de
                      volume entre degraus fica visível sem virar outro gráfico. */}
                  <div
                    className="h-6 overflow-hidden rounded-md bg-muted"
                    style={{ width: `${Math.max((s.sent / maiorEnvio) * 100, 2)}%` }}
                  >
                    <div
                      className="h-full bg-emerald-500"
                      style={{ width: `${s.replyRate * 100}%` }}
                    />
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {plural(s.sent, 'enviada', 'enviadas')}
                  </span>
                </div>

                <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                  <span className="text-muted-foreground">
                    <strong
                      className={`tabular-nums ${
                        s.replied > 0
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-foreground'
                      }`}
                    >
                      {s.replied}
                    </strong>{' '}
                    {s.replied === 1 ? 'respondeu' : 'responderam'} aqui
                    {s.sent > 0 && ` (${pct(s.replyRate)})`}
                  </span>
                  {s.advanced > 0 && (
                    <span className="text-muted-foreground">
                      <strong className="tabular-nums text-foreground">{s.advanced}</strong>{' '}
                      seguiram para o próximo
                    </span>
                  )}
                </div>

                <p className="rounded-r-md border-l-2 border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  {s.label}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Numero({
  rotulo,
  valor,
  nota,
  tom,
}: {
  rotulo: string
  valor: number
  nota: string
  tom?: 'bom' | 'atencao'
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        tom === 'bom'
          ? 'border-emerald-500/30'
          : tom === 'atencao'
            ? 'border-amber-500/40'
            : 'border-border'
      } bg-card`}
    >
      <p
        className={`text-xs ${
          tom === 'bom'
            ? 'font-medium text-emerald-700 dark:text-emerald-400'
            : tom === 'atencao'
              ? 'font-medium text-amber-700 dark:text-amber-500'
              : 'text-muted-foreground'
        }`}
      >
        {rotulo}
      </p>
      <p
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          tom === 'bom'
            ? 'text-emerald-700 dark:text-emerald-400'
            : tom === 'atencao'
              ? 'text-amber-700 dark:text-amber-500'
              : 'text-foreground'
        }`}
      >
        {valor}
      </p>
      {nota && <p className="mt-0.5 text-[11px] text-muted-foreground">{nota}</p>}
    </div>
  )
}
