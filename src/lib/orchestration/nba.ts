// ============================================================
// 🎯 Next Best Action v1 — regras DETERMINÍSTICAS (puro, testável).
// Sinal ativo + contexto do negócio → ação recomendada + motivo + prioridade.
// Alimenta: chip no card (deal_suggestions), Sócio IA, fila de aprovação,
// motor de autonomia.
// ============================================================

import type { OrchAction } from './policy'

export interface SignalLike {
  id?: string
  signalType: string
  severity: number
  payload: Record<string, unknown>
  contactId: string
  dealId: string | null
}

export interface NbaContext {
  /** A conta configurou uma cadência pra negócio parado (autonomy.staleCadenceId). */
  cadenceConfigured?: boolean
  /** O contato já está numa cadência ativa (não inscrever de novo). */
  inCadence?: boolean
  hasProposal: boolean
  proposalAccepted: boolean
  hasConversation: boolean
  dealAssigned: boolean
  contactName?: string | null
  dealTitle?: string | null
}

export interface Recommendation {
  action: OrchAction
  /** Por que (vai pra auditoria e pra fila). */
  reason: string
  /** 0–100 (ordena a fila e o digest). */
  priority: number
  /** Frase curta pro chip do card / digest ("Enviar follow-up: proposta parada há 3 dias"). */
  headline: string
}

/** Sinais que o orquestrador da Fase 2 trata (os de recompra ficam com o motor de reativação). */
/** Acima disso o negócio parado vira backlog morto — o NBA ignora. */
export const STALE_MAX_DAYS = 60

export const ORCHESTRATED_SIGNALS = [
  'proposal_idle',
  'followup_due',
  'stale_deal',
  'high_intent',
  'churn_risk',
  'ticket_declining',
  'customer_reactivated',
  'approval_required',
] as const

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

function who(ctx: NbaContext): string {
  return ctx.contactName?.trim().split(/\s+/)[0] || 'o cliente'
}

function dealRef(ctx: NbaContext): string {
  return ctx.dealTitle ? ` (${ctx.dealTitle})` : ''
}

export function recommend(signal: SignalLike, ctx: NbaContext): Recommendation | null {
  const p = signal.payload ?? {}
  const sev = Math.max(0, Math.min(100, n(signal.severity)))
  switch (signal.signalType) {
    case 'proposal_idle': {
      const days = Math.floor(n(p.hours_idle) / 24)
      const when = days >= 1 ? `há ${days} dia${days > 1 ? 's' : ''}` : 'há mais de 72h'
      return {
        action: 'send_followup',
        reason: `Proposta enviada${dealRef(ctx)} e ${who(ctx)} não respondeu ${when}${p.viewed ? ' (já visualizou)' : ''}.`,
        priority: sev,
        headline: `Enviar follow-up: proposta parada ${when}`,
      }
    }
    case 'followup_due':
      return {
        action: 'send_followup',
        reason: `Follow-up do negócio${dealRef(ctx)} venceu e ${who(ctx)} ainda não respondeu.`,
        priority: sev,
        headline: 'Enviar follow-up: data combinada venceu',
      }
    case 'stale_deal': {
      const days = Math.floor(n(p.days_stale))
      // Parado há mais de 60 dias não é "esfriando", é backlog morto: nada de ação (só limpeza manual).
      if (days > STALE_MAX_DAYS) return null
      if (ctx.hasConversation) {
        // Com cadência configurada, uma SEQUÊNCIA converte mais que uma
        // mensagem solta — e só entra se a pessoa não estiver em outra.
        if (ctx.cadenceConfigured && !ctx.inCadence) {
          return {
            action: 'start_cadence',
            reason: `Negócio${dealRef(ctx)} parado há ${days} dias — colocar ${who(ctx)} na sequência de retomada.`,
            priority: Math.min(sev, 70),
            headline: `Iniciar cadência: parado há ${days} dias`,
          }
        }
        return {
          action: 'send_followup',
          reason: `Negócio${dealRef(ctx)} parado na mesma etapa há ${days} dias, sem movimento.`,
          priority: Math.min(sev, 70),
          headline: `Enviar follow-up: parado há ${days} dias`,
        }
      }
      return {
        action: ctx.dealAssigned ? 'notify_seller' : 'notify_owner',
        reason: `Negócio${dealRef(ctx)} parado há ${days} dias e sem conversa aberta — precisa de contato humano.`,
        priority: Math.min(sev, 60),
        headline: `Avisar: negócio parado há ${days} dias`,
      }
    }
    case 'high_intent':
      if (!ctx.hasProposal) {
        // Sem proposta salva, "enviar" trava. O passo real é MONTAR a proposta
        // (com os produtos já lançados) pro humano revisar — aí o enviar libera.
        return {
          action: 'draft_proposal',
          reason: `${who(ctx)} está quente${dealRef(ctx)} e ainda não tem proposta montada.`,
          priority: Math.max(sev, 70),
          headline: 'Montar proposta: cliente quente sem proposta',
        }
      }
      if (ctx.proposalAccepted) return null
      return {
        action: 'send_followup',
        reason: `${who(ctx)} está quente${dealRef(ctx)} com proposta na mão — hora de fechar.`,
        priority: sev,
        headline: 'Enviar follow-up de fechamento',
      }
    case 'churn_risk':
      // 03/09: o orquestrador NÃO manda reativação — quem reativa é o motor de
      // recompra (lib/ai/autonomy.ts), com cooldown de 7d e as travas dele. Um
      // 'auto' legado da Família do Gás vazou pra cá e mandou "sentimos sua falta"
      // pra quem tinha comprado há 4 dias (venda triplicada nas métricas).
      return null
    case 'ticket_declining':
      return {
        action: 'notify_seller',
        reason: `Última compra de ${who(ctx)} (${fmtMoney(p.last_amount)}) ficou bem abaixo do ticket médio (${fmtMoney(p.avg_ticket)}).`,
        priority: Math.min(sev, 55),
        headline: 'Avisar vendedor: ticket caindo',
      }
    case 'customer_reactivated':
      // Informativo (aparece como sinal); avisar toda vez cansaria o time.
      return null
    case 'approval_required':
      return {
        action: 'notify_owner',
        reason: `Há ações da IA esperando aprovação há mais de ${Math.floor(n(p.hours_waiting))}h.`,
        priority: 40,
        headline: 'Aprovações paradas na fila',
      }
    default:
      return null
  }
}

function fmtMoney(v: unknown): string {
  const x = Number(v)
  if (!Number.isFinite(x)) return '—'
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(x)
  } catch {
    return String(x)
  }
}
