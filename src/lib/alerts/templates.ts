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

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g
/** Separador entre duas variáveis na mesma linha ("{{cliente}} · {{telefone}}"). */
const SEP = String.raw`[ \t]*(?:·|•|\||—|–|-|,)[ \t]*`

/** Valor numa linha só: quebra vira " / ". 16/09 (Família do Gás): resumo com a
 *  localização da cliente quebrava o aviso no meio e, em template
 *  personalizado, fechava o negrito antes da hora. */
const flat = (v: string | undefined): string =>
  (v ?? '')
    .replace(/[ \t]*(?:\r?\n[ \t]*)+/g, ' / ')
    .replace(/\s+/g, ' ')
    .replace(/^(?: \/ )+|(?: \/ )+$/g, '')
    .trim()

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Substitui {{variavel}} pelos valores. Linha que TINHA variável e ficou sem
 *  nenhum dado (todas as vars da linha vazias) é removida — "📝 {{notas}}"
 *  some quando não há notas. Variável vazia leva junto o separador vizinho:
 *  "👤 {{cliente}} · {{telefone}}" sem nome sai "👤 5567…", não "👤  · 5567…". */
export function renderAlertTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  const lines = template.split('\n').map((line) => {
    const varNames = [...line.matchAll(VAR_RE)].map((m) => m[1])
    if (varNames.length > 0 && varNames.every((k) => !flat(vars[k]))) {
      return null
    }
    let l = line
    for (const k of varNames) {
      if (flat(vars[k])) continue
      const v = String.raw`\{\{\s*${escapeRe(k)}\s*\}\}`
      l = l
        .replace(new RegExp(`${v}${SEP}(?=\\{\\{)`), '')
        .replace(new RegExp(`${SEP}${v}`), '')
    }
    return l.replace(VAR_RE, (_, k: string) => flat(vars[k])).replace(/[ \t]+$/, '')
  })
  return lines
    .filter((l): l is string => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
