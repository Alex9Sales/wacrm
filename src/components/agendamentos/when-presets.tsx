'use client'

// ============================================================
// Atalhos de horário do agendar: Em 1 hora · Em 3 horas · Amanhã 9h · Próx.
// semana. Nasceram no agendar de dentro da conversa (6278b9ec) e a tela
// Agendamentos nunca teve — o João usava muito o "Amanhã 9h" e, quando passou
// a agendar pela central por causa dos anexos, achou que tinham sumido (13/09).
// Um componente só, para as duas telas não se separarem de novo.
// ============================================================

const pad = (n: number) => String(n).padStart(2, '0')

/** Date → o valor que um <input type="datetime-local"> espera (hora local, minutos). */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Atalhos relativos a agora, já no formato do datetime-local. */
export function schedulePresets(now = new Date()): { label: string; value: string }[] {
  const inHour = new Date(now.getTime() + 60 * 60 * 1000)
  const in3h = new Date(now.getTime() + 3 * 60 * 60 * 1000)
  const tomorrow9 = new Date(now)
  tomorrow9.setDate(tomorrow9.getDate() + 1)
  tomorrow9.setHours(9, 0, 0, 0)
  const nextWeek9 = new Date(now)
  nextWeek9.setDate(nextWeek9.getDate() + 7)
  nextWeek9.setHours(9, 0, 0, 0)
  return [
    { label: 'Em 1 hora', value: toLocalInput(inHour) },
    { label: 'Em 3 horas', value: toLocalInput(in3h) },
    { label: 'Amanhã 9h', value: toLocalInput(tomorrow9) },
    { label: 'Próx. semana', value: toLocalInput(nextWeek9) },
  ]
}

export function WhenPresets({ onPick }: { onPick: (value: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      {schedulePresets().map((p) => (
        <button
          key={p.label}
          type="button"
          onClick={() => onPick(p.value)}
          className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}
