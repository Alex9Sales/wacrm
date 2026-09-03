// ============================================================
// 🧠 Fase 2 — Política de autonomia (PURA, testável, client-safe).
//
//   sinal → NBA recomenda uma AÇÃO → esta política decide:
//     auto_execute | request_approval | suggest_only | blocked | deferred
//
// A regra final considera: nível configurado POR AÇÃO no agente
// (ai_configs.autonomy) + risco da ação (catálogo) + contexto (kill switch,
// horário, opt-out, humano ativo na conversa, tetos, limite por negócio,
// desconto acima do limite). "Nunca atropela humano" e "crítico nunca é auto"
// são invariantes — não dá pra configurar por cima.
// ============================================================

export const ORCH_ACTIONS = [
  'reactivation',
  'send_followup',
  'move_deal',
  'create_task',
  'update_follow_up',
  'notify_seller',
  'notify_owner',
  'send_proposal',
  'apply_discount',
  'close_deal',
  'escalate',
  'start_cadence',
  'pause_cadence',
] as const
export type OrchAction = (typeof ORCH_ACTIONS)[number]

export type Level = 'suggest' | 'approve' | 'auto'
export type Risk = 'low' | 'medium' | 'high' | 'critical'
export type Decision = 'auto_execute' | 'request_approval' | 'suggest_only' | 'blocked' | 'deferred'

export interface ActionMeta {
  label: string
  /** O que a ação faz, em 1 linha (fila de aprovação e config). */
  hint: string
  risk: Risk
  defaultLevel: Level
  /** message = fala com o cliente (horário/opt-out/humano valem) · crm = mexe no CRM · notify = avisa o time · money = dinheiro */
  kind: 'message' | 'crm' | 'notify' | 'money'
  /** Só o humano consegue executar (precisa de sessão / side effects do app). */
  humanOnly?: boolean
}

export const ACTION_CATALOG: Record<OrchAction, ActionMeta> = {
  reactivation: { label: 'Reativar cliente', hint: 'Chama de volta quem está atrasado na recompra ou sumiu.', risk: 'medium', defaultLevel: 'suggest', kind: 'message' },
  send_followup: { label: 'Enviar follow-up', hint: 'Cutuca o cliente de um negócio parado (proposta sem resposta, follow-up vencido).', risk: 'medium', defaultLevel: 'suggest', kind: 'message' },
  move_deal: { label: 'Mover negócio de etapa', hint: 'Avança ou recua o card no funil.', risk: 'low', defaultLevel: 'approve', kind: 'crm' },
  create_task: { label: 'Criar tarefa', hint: 'Abre uma tarefa pro vendedor com prazo.', risk: 'low', defaultLevel: 'auto', kind: 'crm' },
  update_follow_up: { label: 'Reagendar follow-up', hint: 'Ajusta a data do próximo follow-up do negócio.', risk: 'low', defaultLevel: 'auto', kind: 'crm' },
  notify_seller: { label: 'Avisar vendedor', hint: 'Notifica o responsável pelo negócio.', risk: 'low', defaultLevel: 'auto', kind: 'notify' },
  notify_owner: { label: 'Avisar dono/admin', hint: 'Notifica os administradores da conta.', risk: 'low', defaultLevel: 'auto', kind: 'notify' },
  send_proposal: { label: 'Enviar proposta', hint: 'Manda a proposta do negócio por e-mail.', risk: 'high', defaultLevel: 'approve', kind: 'money', humanOnly: true },
  // Não é 'só humano': aplicar desconto só GRAVA na proposta salva (nada sai
  // pro cliente). Acima do limite configurado vira aprovação — ver decide().
  apply_discount: { label: 'Aplicar desconto', hint: 'Ajusta o desconto da proposta salva (até o limite, sem aprovação). Não envia nada ao cliente.', risk: 'high', defaultLevel: 'approve', kind: 'money' },
  close_deal: { label: 'Fechar negócio', hint: 'Marca como ganho ou perdido.', risk: 'critical', defaultLevel: 'approve', kind: 'crm', humanOnly: true },
  escalate: { label: 'Escalar pra humano', hint: 'Tira a IA da frente e chama o time.', risk: 'low', defaultLevel: 'auto', kind: 'notify' },
  start_cadence: { label: 'Iniciar cadência', hint: 'Coloca o contato numa sequência de mensagens.', risk: 'medium', defaultLevel: 'approve', kind: 'message' },
  pause_cadence: { label: 'Pausar cadência', hint: 'Interrompe a sequência em andamento.', risk: 'low', defaultLevel: 'auto', kind: 'crm' },
}

export const LEVELS: Level[] = ['suggest', 'approve', 'auto']

export interface AutonomyPolicy {
  levels: Partial<Record<OrchAction, Level>>
  /** Teto de execuções AUTOMÁTICAS por ação por 24h (default 20; mensagens contam também no teto global). */
  caps: Partial<Record<OrchAction, number>>
  /** Desconto (%) que a IA pode aplicar sem aprovação. */
  discountAutoMaxPct: number
  /** Kill switch do AGENTE (a conta tem o dela em account_settings.autonomyPaused). */
  paused: boolean
  /** Se um humano falou na conversa nas últimas N horas, a IA não age sozinha (pede aprovação). */
  humanCooldownHours: number
  /** Máximo de ações automáticas por NEGÓCIO por dia. */
  maxAutoPerDealPerDay: number
  /** Máximo de MENSAGENS automáticas por dia (todas as ações de mensagem somadas). */
  maxAutoMessagesPerDay: number
}

export const DEFAULT_POLICY: AutonomyPolicy = {
  levels: {},
  caps: {},
  discountAutoMaxPct: 5,
  paused: false,
  humanCooldownHours: 24,
  maxAutoPerDealPerDay: 1,
  maxAutoMessagesPerDay: 30,
}

function isLevel(v: unknown): v is Level {
  return v === 'suggest' || v === 'approve' || v === 'auto'
}

/** Lê a política do jsonb `ai_configs.autonomy` (aceita o legado `{reactivation:'auto'}`). */
export function readPolicy(autonomy: unknown): AutonomyPolicy {
  const a = (autonomy && typeof autonomy === 'object' ? autonomy : {}) as Record<string, unknown>
  const levels: Partial<Record<OrchAction, Level>> = {}
  const actions = (a.actions && typeof a.actions === 'object' ? a.actions : {}) as Record<string, unknown>
  for (const act of ORCH_ACTIONS) {
    const v = actions[act]
    if (isLevel(v)) levels[act] = v
  }
  // legado: chave solta `reactivation`
  if (!levels.reactivation && isLevel(a.reactivation)) levels.reactivation = a.reactivation
  const caps: Partial<Record<OrchAction, number>> = {}
  const rawCaps = (a.caps && typeof a.caps === 'object' ? a.caps : {}) as Record<string, unknown>
  for (const act of ORCH_ACTIONS) {
    const n = Number(rawCaps[act])
    if (Number.isFinite(n) && n >= 1) caps[act] = Math.min(500, Math.floor(n))
  }
  // legado: reactivationDailyCap
  const legacyCap = Number(a.reactivationDailyCap)
  if (!caps.reactivation && Number.isFinite(legacyCap) && legacyCap >= 1) caps.reactivation = Math.min(500, Math.floor(legacyCap))
  const pct = Number(a.discountAutoMaxPct)
  const hc = Number(a.humanCooldownHours)
  const perDeal = Number(a.maxAutoPerDealPerDay)
  const perDayMsgs = Number(a.maxAutoMessagesPerDay)
  return {
    levels,
    caps,
    discountAutoMaxPct: Number.isFinite(pct) && pct >= 0 ? Math.min(100, pct) : DEFAULT_POLICY.discountAutoMaxPct,
    paused: a.paused === true,
    humanCooldownHours: Number.isFinite(hc) && hc >= 0 ? Math.min(168, hc) : DEFAULT_POLICY.humanCooldownHours,
    maxAutoPerDealPerDay: Number.isFinite(perDeal) && perDeal >= 1 ? Math.min(10, Math.floor(perDeal)) : DEFAULT_POLICY.maxAutoPerDealPerDay,
    maxAutoMessagesPerDay:
      Number.isFinite(perDayMsgs) && perDayMsgs >= 1 ? Math.min(500, Math.floor(perDayMsgs)) : DEFAULT_POLICY.maxAutoMessagesPerDay,
  }
}

/** Nível efetivo da ação (configurado ou default do catálogo). */
export function levelFor(policy: AutonomyPolicy, action: OrchAction): Level {
  return policy.levels[action] ?? ACTION_CATALOG[action].defaultLevel
}

/** Teto padrão por 24h: avisos são baratos mas cansam (5); o resto 20. */
export function capFor(policy: AutonomyPolicy, action: OrchAction): number {
  return policy.caps[action] ?? (ACTION_CATALOG[action].kind === 'notify' ? 5 : 20)
}

export interface DecisionContext {
  action: OrchAction
  policy: AutonomyPolicy
  /** account_settings.autonomyPaused */
  accountPaused: boolean
  /** Dentro do horário permitido pra falar com cliente. */
  withinHours: boolean
  optedOut: boolean
  /** Humano (atendente) falou na conversa dentro do cooldown. */
  humanActiveRecently: boolean
  /** IA desligada nesta conversa (botão IA off). */
  aiDisabledInConversation: boolean
  /** Ações automáticas desta ação nas últimas 24h. */
  usedToday: number
  /** Mensagens automáticas (todas as ações de mensagem) nas últimas 24h. */
  messagesToday: number
  /** Ações automáticas neste negócio nas últimas 24h. */
  usedForDealToday: number
  /** Só pra apply_discount. */
  discountPct?: number
  /** Risco da FERRAMENTA externa envolvida, se houver (agent_tools.risk). */
  toolRisk?: Risk
}

export interface PolicyDecision {
  decision: Decision
  level: Level
  /** Explicação curta, em português, pra auditoria/fila. */
  reason: string
}

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 }

/** Decide o destino de uma ação recomendada. Determinística. */
export function decide(ctx: DecisionContext): PolicyDecision {
  const meta = ACTION_CATALOG[ctx.action]
  const level = levelFor(ctx.policy, ctx.action)
  const isMessage = meta.kind === 'message'
  const base = `${ctx.action}=${level} · risco ${meta.risk}`

  if (ctx.accountPaused) return { decision: 'blocked', level, reason: `${base} · kill switch da conta ligado` }
  if (ctx.policy.paused) return { decision: 'blocked', level, reason: `${base} · autonomia do agente pausada` }
  if (isMessage && ctx.optedOut) return { decision: 'blocked', level, reason: `${base} · contato pediu pra não receber mensagens` }

  if (level === 'suggest') return { decision: 'suggest_only', level, reason: `${base} · política = só sugerir` }

  // Invariantes: crítico e "só humano" nunca rodam sozinhos. O risco da
  // FERRAMENTA externa envolvida (agent_tools.risk) sobrepõe o do catálogo
  // quando é maior — ferramenta 'critical' força aprovação mesmo em ação leve.
  const effectiveRisk = ctx.toolRisk && RISK_RANK[ctx.toolRisk] > RISK_RANK[meta.risk] ? ctx.toolRisk : meta.risk
  if (level === 'approve' || meta.humanOnly || effectiveRisk === 'critical') {
    return {
      decision: 'request_approval',
      level,
      reason: meta.humanOnly
        ? `${base} · ação só o humano executa`
        : effectiveRisk === 'critical'
          ? `${base} · risco crítico exige aprovação`
          : `${base} · política = aprovar`,
    }
  }

  // level === 'auto'
  if (ctx.action === 'apply_discount') {
    const pct = ctx.discountPct ?? 0
    if (pct > ctx.policy.discountAutoMaxPct) {
      return { decision: 'request_approval', level, reason: `${base} · desconto ${pct}% acima do limite automático de ${ctx.policy.discountAutoMaxPct}%` }
    }
  }
  if (isMessage && (ctx.humanActiveRecently || ctx.aiDisabledInConversation)) {
    return {
      decision: 'request_approval',
      level,
      reason: ctx.aiDisabledInConversation ? `${base} · IA desligada nesta conversa — não atropela o humano` : `${base} · humano falou com o cliente há pouco — não atropela`,
    }
  }
  if (isMessage && !ctx.withinHours) return { decision: 'deferred', level, reason: `${base} · fora do horário — tenta no próximo tick` }
  if (ctx.usedToday >= capFor(ctx.policy, ctx.action)) return { decision: 'blocked', level, reason: `${base} · teto diário da ação (${capFor(ctx.policy, ctx.action)}) atingido` }
  if (isMessage && ctx.messagesToday >= ctx.policy.maxAutoMessagesPerDay) {
    return { decision: 'blocked', level, reason: `${base} · teto diário de mensagens automáticas (${ctx.policy.maxAutoMessagesPerDay}) atingido` }
  }
  if (ctx.usedForDealToday >= ctx.policy.maxAutoPerDealPerDay) {
    return { decision: 'blocked', level, reason: `${base} · limite de ${ctx.policy.maxAutoPerDealPerDay} ação automática por negócio/dia` }
  }
  return { decision: 'auto_execute', level, reason: `${base} · dentro do teto e do horário` }
}
