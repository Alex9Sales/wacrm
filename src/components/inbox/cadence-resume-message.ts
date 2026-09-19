// Aviso de "cadência retomada" (compositor e aba lateral): diz QUANDO sai o
// próximo toque. Retomar não manda nada na hora — 19/09 o Rafael retomou
// esperando o ritmo normal e só descobriu o horário quando a mensagem saiu.

export function resumedMessage(scheduled: number, nextAt: string | null): string {
  if (!nextAt) {
    return scheduled ? `Cadência retomada — ${scheduled} toque(s) reagendado(s).` : 'Cadência retomada.'
  }
  const when = new Date(nextAt).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const rest = scheduled > 1 ? ` (${scheduled} toques no total)` : ''
  return `Cadência retomada — próximo toque em ${when}${rest}.`
}
