import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

type MetricTone = 'blue' | 'violet' | 'emerald' | 'amber'

const METRIC_TONES: Record<MetricTone, { chip: string; bar: string; ring: string }> = {
  blue: {
    chip: 'bg-sky-500/12 text-sky-600 dark:text-sky-400',
    bar: 'from-sky-500/70 to-sky-500/0',
    ring: 'ring-sky-500/20',
  },
  violet: {
    chip: 'bg-violet-500/12 text-violet-600 dark:text-violet-400',
    bar: 'from-violet-500/70 to-violet-500/0',
    ring: 'ring-violet-500/20',
  },
  emerald: {
    chip: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
    bar: 'from-emerald-500/70 to-emerald-500/0',
    ring: 'ring-emerald-500/20',
  },
  amber: {
    chip: 'bg-amber-500/12 text-amber-600 dark:text-amber-400',
    bar: 'from-amber-500/70 to-amber-500/0',
    ring: 'ring-amber-500/20',
  },
}

interface MetricCardProps {
  title: string
  /** Pre-formatted value for display (e.g. "42" or "$1,250"). */
  value: string
  icon: ComponentType<{ className?: string }>
  /** Accent tone — colored chip + top accent bar. Defaults to blue. */
  tone?: MetricTone
  /**
   * Delta-mode secondary row: arrow + delta text. Omit when the metric
   * doesn't have a sensible comparison (e.g. total pipeline value).
   */
  delta?: {
    /** Positive / negative / zero drives arrow + color. */
    sign: number
    /** Pre-formatted delta, e.g. "+3 vs yesterday". */
    label: string
  }
  /** Used instead of `delta` when the metric has a static subtitle. */
  subtitle?: string
}

export function MetricCard({
  title,
  value,
  icon: Icon,
  tone = 'blue',
  delta,
  subtitle,
}: MetricCardProps) {
  const t = METRIC_TONES[tone]
  return (
    <div className={cn('relative overflow-hidden rounded-xl bg-card p-5 ring-1', t.ring)}>
      <span
        className={cn('pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r', t.bar)}
      />
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <div className={cn('flex h-8 w-8 items-center justify-center rounded-lg', t.chip)}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="mt-3 text-[28px] leading-none font-bold tabular-nums text-foreground">
        {value}
      </p>
      {delta ? <DeltaRow sign={delta.sign} label={delta.label} /> : subtitle ? (
        <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  )
}

function DeltaRow({ sign, label }: { sign: number; label: string }) {
  const tone =
    sign > 0
      ? 'text-primary'
      : sign < 0
      ? 'text-red-400'
      : 'text-muted-foreground'
  const Arrow = sign > 0 ? ArrowUp : sign < 0 ? ArrowDown : Minus
  return (
    <div className={cn('mt-2 flex items-center gap-1 text-sm', tone)}>
      <Arrow className="h-4 w-4" aria-hidden />
      <span className="tabular-nums">{label}</span>
    </div>
  )
}
