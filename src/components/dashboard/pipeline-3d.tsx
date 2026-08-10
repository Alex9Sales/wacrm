'use client'

// ============================================================
// Funil de vendas em 3D — barras isométricas desenhadas em SVG
// (faces frente/topo/lado calculadas; sombreamento por overlay rgba,
// então funciona com qualquer formato de cor). Sem dependência de lib
// 3D — projeção oblíqua simples, previsível e leve.
// ============================================================

import type { PipelineDonutData } from '@/lib/dashboard/types'
import { formatCurrencyShort } from '@/lib/currency'

export function Pipeline3D({
  data,
  loading,
  currency,
}: {
  data: PipelineDonutData | null
  loading: boolean
  currency: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-heading text-base font-medium text-foreground">Funil de vendas</h3>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
          3D
        </span>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">Valor por etapa nos negócios em aberto.</p>
      {loading || !data ? (
        <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
          Carregando…
        </div>
      ) : data.stages.length === 0 ? (
        <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
          Nenhum negócio em aberto.
        </div>
      ) : (
        <Iso stages={data.stages} currency={currency} />
      )}
    </div>
  )
}

function Iso({
  stages,
  currency,
}: {
  stages: PipelineDonutData['stages']
  currency: string
}) {
  // Geometria da barra + profundidade oblíqua. Ângulo ~40° (era 30°) e
  // profundidade maior → topo mais visível, barra mais "3D".
  const W = 56
  const GAP = 52
  const D = 44 // profundidade da extrusão (era 26)
  const dx = Math.round(D * 0.766) // cos(40°)
  const dy = Math.round(D * 0.643) // sin(40°)
  const maxBarH = 168
  const minBarH = 10
  const topPad = 48 // acomoda o topo mais alto (dy maior)
  const bottomPad = 48
  const leftPad = 22
  const rightPad = 24

  const maxVal = Math.max(1, ...stages.map((s) => s.totalValue))
  const baseline = topPad + maxBarH
  const vbW = leftPad + stages.length * W + (stages.length - 1) * GAP + dx + rightPad
  const vbH = baseline + bottomPad

  const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

  return (
    <svg
      viewBox={`0 0 ${vbW} ${vbH}`}
      className="mx-auto block w-full"
      style={{ maxHeight: 340 }}
      role="img"
      aria-label="Funil de vendas em 3D"
    >
      <style>{`
        .bar3d {
          transform-box: fill-box;
          transform-origin: bottom;
          animation: grow3d .6s cubic-bezier(.22,1,.36,1) both;
        }
        @keyframes grow3d { from { transform: scaleY(0); } to { transform: scaleY(1); } }
        @media (prefers-reduced-motion: reduce) { .bar3d { animation: none; } }
      `}</style>
      {/* piso sutil */}
      <line
        x1={leftPad - 8}
        y1={baseline + 0.5}
        x2={vbW - rightPad + dx}
        y2={baseline + 0.5}
        stroke="var(--border)"
        strokeWidth={1}
      />
      {stages.map((s, i) => {
        const val = s.totalValue
        const barH = val > 0 ? Math.max(minBarH, Math.round((val / maxVal) * maxBarH)) : minBarH
        const x = leftPad + i * (W + GAP)
        const yTop = baseline - barH
        const yBot = baseline
        const color = s.color || '#6366f1'
        const topPts = `${x},${yTop} ${x + W},${yTop} ${x + W + dx},${yTop - dy} ${x + dx},${yTop - dy}`
        const sidePts = `${x + W},${yTop} ${x + W + dx},${yTop - dy} ${x + W + dx},${yBot - dy} ${x + W},${yBot}`
        return (
          <g key={s.id}>
            {/* barra 3D (anima crescendo a partir da base) */}
            <g className="bar3d" style={{ animationDelay: `${i * 80}ms` }}>
              {/* lado direito (mais escuro) */}
              <polygon points={sidePts} fill={color} />
              <polygon points={sidePts} fill="rgba(0,0,0,0.30)" />
              {/* topo (mais claro) */}
              <polygon points={topPts} fill={color} />
              <polygon points={topPts} fill="rgba(255,255,255,0.28)" />
              {/* frente */}
              <rect x={x} y={yTop} width={W} height={barH} fill={color} rx={1} />
            </g>
            {/* valor acima */}
            <text
              x={x + W / 2 + dx / 2}
              y={yTop - dy - 8}
              textAnchor="middle"
              fontSize={12}
              fontWeight={700}
              fill="var(--foreground)"
            >
              {formatCurrencyShort(val, currency)}
            </text>
            {/* nome da etapa */}
            <text
              x={x + W / 2}
              y={baseline + 18}
              textAnchor="middle"
              fontSize={11}
              fill="var(--muted-foreground)"
            >
              {trunc(s.name, 12)}
            </text>
            {/* contagem */}
            <text
              x={x + W / 2}
              y={baseline + 33}
              textAnchor="middle"
              fontSize={10}
              fill="var(--muted-foreground)"
            >
              {s.dealCount} {s.dealCount === 1 ? 'negócio' : 'negócios'}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
