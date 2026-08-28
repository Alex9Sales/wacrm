// Templates padrão dos Avisos do responsável + render — módulo PURO
// (client-safe: a UI mostra como placeholder; o runtime usa pra enviar).

export type OwnerAlertKind = 'won' | 'handoff' | 'booking' | 'order' | 'demo'

/** O cliente pode substituir por conta (Config→Negócios). Variáveis {{assim}}. */
export const DEFAULT_ALERT_TEMPLATES: Record<OwnerAlertKind, string> = {
  demo: `🎯 *TESTE/DEMO AGENDADO PELO SDR*

👤 {{cliente}} · {{telefone}}
🏢 {{empresa}}
📋 {{resumo}}

O card já está no funil — entre no FluxiaCRM pra dar sequência.`,
  order: `🛒 *PEDIDO CONFIRMADO PELA IA*

📦 {{titulo}}
💰 {{valor}}
👤 {{cliente}} · {{telefone}}
📝 {{resumo}}

O card já está no funil do FluxiaCRM.`,
  won: `🏆 *VENDA FECHADA*

📦 {{titulo}}
💰 {{valor}}
👤 {{cliente}} · {{telefone}}
📝 {{notas}}

Detalhes no funil do FluxiaCRM.`,
  handoff: `🔁 *IA TRANSFERIU PRA HUMANO*

👤 {{cliente}} · {{telefone}}
🏷️ Motivo: {{motivo}}

📋 Resumo: {{resumo}}

Entre na conversa pelo FluxiaCRM pra continuar o atendimento.`,
  booking: `📅 *NOVO AGENDAMENTO*

👤 {{nome}} · {{telefone}}
🗓️ {{quando}} — {{agenda}}
📍 {{local}}

Marcado pela página pública de agendamento.`,
}

/** Substitui {{variavel}} pelos valores. Linha que TINHA variável e ficou sem
 *  nenhum dado (todas as vars da linha vazias) é removida — "📝 {{notas}}"
 *  some quando não há notas. */
export function renderAlertTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  const lines = template.split('\n').map((line) => {
    const varNames = [...line.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map(
      (m) => m[1],
    )
    const rendered = line.replace(
      /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
      (_, k: string) => (vars[k] ?? '').trim(),
    )
    if (varNames.length > 0 && varNames.every((k) => !(vars[k] ?? '').trim())) {
      return null
    }
    return rendered
  })
  return lines
    .filter((l): l is string => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
