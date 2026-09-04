// ============================================================
// 🔙 Fase 2 — REVERSÃO e CORREÇÃO das ações da IA.
//
// Regra que veio da discussão com o Alex (03/09): **nem toda ação é reversível
// do mesmo jeito**, e prometer "desfazer" onde não dá é vender falsa segurança.
//
//   REVERSÍVEL de verdade (volta ao estado anterior):
//     move_deal          → devolve o card pra etapa de antes
//     create_task        → cancela a tarefa criada
//     update_follow_up   → restaura a data anterior
//     start_cadence      → tira o contato da cadência
//     apply_discount     → restaura o desconto anterior da proposta
//     draft_proposal     → cancela a proposta, SE não foi aceita
//
//   NÃO REVERSÍVEL (o mundo já viu):
//     send_followup / reactivation → mensagem entregue não volta. Vira
//       CORREÇÃO: marca resultado ruim, PAUSA a IA naquela conversa e o humano
//       assume pra responder.
//     send_proposal (e-mail já enviado) → idem; se a proposta ainda não foi
//       aceita dá pra cancelar o documento, mas o e-mail já saiu.
//     close_deal com venda registrada, desconto já comunicado → escala, não
//       desfaz em silêncio.
//     notify_* / escalate → nada a desfazer (só registra o julgamento).
//
// Parte PURA (client-safe): a matriz e os rótulos. O executor fica em
// revert-actions.ts (mexe no banco).
// ============================================================

import type { OrchAction } from './policy'

export type RevertKind =
  /** Volta ao estado anterior de verdade. */
  | 'undo'
  /** Não volta: pausa a IA na conversa e o humano corrige. */
  | 'correct'
  /** Nada a desfazer — só registra que o resultado foi ruim. */
  | 'note_only'
  /** Precisa de gente: consequência já saiu no mundo (dinheiro/venda). */
  | 'escalate'

export interface RevertPlan {
  kind: RevertKind
  /** Rótulo do botão na auditoria. */
  label: string
  /** O que EXATAMENTE vai acontecer (mostrado antes de confirmar). */
  effect: string
}

export const REVERT_MATRIX: Record<OrchAction, RevertPlan> = {
  move_deal: {
    kind: 'undo',
    label: 'Desfazer',
    effect: 'Devolve o negócio para a etapa em que estava antes e registra a correção no histórico.',
  },
  create_task: {
    kind: 'undo',
    label: 'Desfazer',
    effect: 'Cancela a tarefa que a IA criou.',
  },
  update_follow_up: {
    kind: 'undo',
    label: 'Desfazer',
    effect: 'Restaura a data de follow-up que existia antes.',
  },
  start_cadence: {
    kind: 'undo',
    label: 'Tirar da cadência',
    effect: 'Remove o contato da cadência e cancela as mensagens que ainda não saíram.',
  },
  pause_cadence: {
    kind: 'note_only',
    label: 'Marcar como errado',
    effect: 'A cadência foi pausada — retomar é decisão sua, na tela de cadências. Aqui só registramos que a ação foi um erro.',
  },
  apply_discount: {
    kind: 'undo',
    label: 'Desfazer desconto',
    effect: 'Restaura o desconto anterior da proposta. Se o valor já foi combinado com o cliente, fale com ele antes.',
  },
  draft_proposal: {
    kind: 'undo',
    label: 'Cancelar proposta',
    effect: 'Apaga a proposta montada (só quando ainda não foi aceita pelo cliente).',
  },
  send_proposal: {
    kind: 'escalate',
    label: 'Marcar como errado',
    effect: 'O e-mail com a proposta já saiu — não dá para desfazer. Registramos como resultado ruim e avisamos o responsável.',
  },
  send_followup: {
    kind: 'correct',
    label: 'Corrigir',
    effect: 'A mensagem já foi entregue e não volta. A IA é pausada nesta conversa e você assume para responder ao cliente.',
  },
  collect_charges: {
    kind: 'correct',
    label: 'Corrigir',
    effect: 'A cobrança já chegou ao cliente e não volta. A IA é pausada nesta conversa, a régua para neste devedor e você assume para resolver.',
  },
  reactivation: {
    kind: 'correct',
    label: 'Corrigir',
    effect: 'A mensagem já foi entregue e não volta. A IA é pausada nesta conversa e você assume para responder ao cliente.',
  },
  close_deal: {
    kind: 'escalate',
    label: 'Marcar como errado',
    effect: 'Fechar negócio mexe em venda registrada — reabra pelo próprio card, com o motivo. Aqui registramos o erro.',
  },
  notify_seller: { kind: 'note_only', label: 'Marcar como errado', effect: 'O aviso já foi lido pelo time; só registramos que não era pertinente.' },
  notify_owner: { kind: 'note_only', label: 'Marcar como errado', effect: 'O aviso já foi lido pelo time; só registramos que não era pertinente.' },
  escalate: { kind: 'note_only', label: 'Marcar como errado', effect: 'Só registramos que escalar não era necessário. A IA continua pausada na conversa até você religar.' },
}

/** Assinatura do contexto para agrupar decisões parecidas (sem dado do cliente). */
export function contextFingerprint(action: string, signalType: string | null, severity: number | null): string {
  const faixa = severity == null ? 'na' : severity >= 80 ? 'alta' : severity >= 50 ? 'media' : 'baixa'
  return `${action}|${signalType ?? 'sem-sinal'}|${faixa}`
}

/** Motivos prontos de recusa/reversão (viram reason_code, agrupável). */
export const REASON_CODES: { code: string; label: string }[] = [
  { code: 'timing', label: 'Momento errado (cliente pediu para falar depois)' },
  { code: 'wrong_content', label: 'Conteúdo errado ou fora de contexto' },
  { code: 'already_handled', label: 'Já estava resolvido / alguém já tinha falado' },
  { code: 'wrong_customer', label: 'Cliente errado para essa ação' },
  { code: 'tone', label: 'Tom ou texto não ficou bom' },
  { code: 'not_needed', label: 'Não era necessário' },
  { code: 'other', label: 'Outro motivo' },
]
