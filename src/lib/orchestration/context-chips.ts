// Chips de contexto do pedido de ação (payload do sinal) em português curto.
// Compartilhado pela fila "Precisa de você" e pelo painel de validação.
export function contextChips(p: Record<string, unknown>): string[] {
  const out: string[] = []
  if (typeof p.hours_idle === 'number') out.push(`${Math.floor(p.hours_idle / 24)}d sem resposta`)
  if (p.viewed === true) out.push('proposta visualizada')
  if (typeof p.days_stale === 'number') out.push(`parado ${p.days_stale}d`)
  if (typeof p.days_since === 'number') out.push(`${p.days_since}d sem comprar`)
  if (typeof p.avg_days === 'number') out.push(`média ${p.avg_days}d`)
  if (typeof p.qualification === 'number') out.push(`qualificação ${p.qualification}/5`)
  if (typeof p.temperature === 'string' && p.temperature) out.push(String(p.temperature))
  if (typeof p.severity === 'number') out.push(`prioridade ${p.severity}`)
  return out
}
