// ============================================================
// Ferramentas do agente (Fase A) — catálogo das ações que a IA pode fazer no
// CRM. Cada agente tem um conjunto de ferramentas LIGADAS (ai_configs.tools).
// Client-safe: não importa nada server-only (o painel usa isto).
//
// As ferramentas são executadas por MARCADORES no texto gerado (ver
// parseCloseDirectives em defaults.ts + close-actions/schedule-actions). Este
// arquivo é só o catálogo + os defaults; a lógica fica no runtime.
// ============================================================

export type AgentToolKey =
  | 'skip_reply'
  | 'tag'
  | 'handoff'
  | 'resolve'
  | 'move_card'
  | 'schedule'
  | 'create_card'
  | 'private_note'
  | 'set_attribute'
  | 'voice_pref'

export interface AgentToolDef {
  key: AgentToolKey
  label: string
  description: string
  group: 'Conversa' | 'Funil' | 'Utilitária'
  /** Vem ligada por padrão num agente novo. */
  defaultOn: boolean
  /** Já funciona hoje (senão aparece "em breve", desligada). */
  implemented: boolean
}

export const AGENT_TOOLS: AgentToolDef[] = [
  {
    key: 'skip_reply',
    label: 'Não responder',
    description:
      'Ignora mensagens que não pedem resposta (só "ok", um emoji, agradecimento).',
    group: 'Conversa',
    defaultOn: true,
    implemented: true,
  },
  {
    key: 'tag',
    label: 'Adicionar etiqueta',
    description:
      'Etiqueta o contato pra qualificar/organizar (usa só as etiquetas que já existem).',
    group: 'Conversa',
    defaultOn: true,
    implemented: true,
  },
  {
    key: 'handoff',
    label: 'Transferir pra humano',
    description:
      'Passa a conversa pra um atendente quando o cliente pede ou a IA não resolve.',
    group: 'Conversa',
    defaultOn: true,
    implemented: true,
  },
  {
    key: 'resolve',
    label: 'Resolver conversa',
    description: 'Marca a conversa como resolvida quando o atendimento termina.',
    group: 'Conversa',
    defaultOn: false,
    implemented: true,
  },
  {
    key: 'move_card',
    label: 'Mover card do funil',
    description: 'Move o card do negócio pra outra etapa (ex.: Perdido, Reativar).',
    group: 'Funil',
    defaultOn: false,
    implemented: true,
  },
  {
    key: 'schedule',
    label: 'Agendar reunião',
    description:
      'Cria o evento na Agenda quando combina um horário (espelha no Google).',
    group: 'Conversa',
    defaultOn: false,
    implemented: true,
  },
  {
    key: 'create_card',
    label: 'Criar card / tarefa',
    description: 'Cria um novo card (negócio/tarefa) no funil.',
    group: 'Funil',
    defaultOn: false,
    implemented: false,
  },
  {
    key: 'private_note',
    label: 'Nota interna',
    description: 'Publica uma nota visível só pros atendentes, não pro cliente.',
    group: 'Conversa',
    defaultOn: false,
    implemented: false,
  },
  {
    key: 'set_attribute',
    label: 'Definir atributo',
    description:
      'Grava um atributo personalizado na conversa/contato (ex.: estágio do lead).',
    group: 'Conversa',
    defaultOn: false,
    implemented: false,
  },
  {
    key: 'voice_pref',
    label: 'Preferência de voz',
    description: 'Registra se o cliente prefere respostas em áudio ou texto.',
    group: 'Utilitária',
    defaultOn: false,
    implemented: false,
  },
]

/** Ferramentas ligadas num agente novo. */
export const DEFAULT_TOOLS: AgentToolKey[] = AGENT_TOOLS.filter(
  (t) => t.defaultOn,
).map((t) => t.key)

const IMPLEMENTED = new Set(
  AGENT_TOOLS.filter((t) => t.implemented).map((t) => t.key),
)

/** Sanitiza uma lista vinda do cliente/banco → só chaves conhecidas e implementadas. */
export function sanitizeTools(input: unknown): AgentToolKey[] {
  if (!Array.isArray(input)) return [...DEFAULT_TOOLS]
  const out: AgentToolKey[] = []
  for (const v of input) {
    if (typeof v === 'string' && IMPLEMENTED.has(v as AgentToolKey)) {
      if (!out.includes(v as AgentToolKey)) out.push(v as AgentToolKey)
    }
  }
  return out
}

/** Helper: o agente tem essa ferramenta ligada? */
export function hasTool(tools: string[] | undefined, key: AgentToolKey): boolean {
  return !!tools && tools.includes(key)
}
