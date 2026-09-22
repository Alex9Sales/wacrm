// ============================================================
// 🔔 Plano de UMA leitura das parcelas a vencer (ver reminders.ts/scanUpcoming).
//
// A régua tica a cada 10 min. A leitura da JANELA da fila (0..N dias) sempre
// foi a cada tique — é pequena. A leitura COMPLETA (30 dias, tela "Próximos
// vencimentos", 22/09) é 8+ páginas no Asaas mais os cadastros que ainda não
// conhecemos: a cada 10 min renderia 429. Então ela roda no máximo uma vez por
// hora por conexão; nas outras rodadas a leitura fica na janela e a limpeza
// só toca o intervalo que foi lido.
//
// Puro, sem banco: testável.
// ============================================================

import { addDaysKey } from './upcoming-unmatched'

/** Quantos dias à frente a leitura completa GUARDA. */
export const UPCOMING_HORIZON_DAYS = 30
/** Intervalo mínimo entre duas leituras completas da mesma conexão. */
export const FULL_SCAN_EVERY_MS = 60 * 60_000

export interface UpcomingScanPlan {
  /** Janela da FILA em dias: N com lembrete ligado, 0 só com o aviso do dia, -1 = nada a enfileirar. */
  reminderWindow: number
  /** true = leitura completa (horizonte); false = só a janela da fila. */
  full: boolean
  from: string
  /** Último dia lido (inclusive); null = nada a ler nesta rodada. */
  until: string | null
}

/** Janela da fila pelas configurações: N dias, só hoje (aviso do dia) ou nada. */
export function reminderWindowFor(s: { reminderDaysBefore: number; remindOnDueDate: boolean }): number {
  if (s.reminderDaysBefore > 0) return s.reminderDaysBefore
  return s.remindOnDueDate ? 0 : -1
}

export function upcomingScanPlan(args: {
  todayKey: string
  reminderDaysBefore: number
  remindOnDueDate: boolean
  /** Última leitura completa desta conexão (ms); 0 = nunca (ou o worker reiniciou). */
  lastFullScanAt: number
  now: number
  /** Força a completa (botão Atualizar da carteira). */
  force?: boolean
  horizonDays?: number
  fullEveryMs?: number
}): UpcomingScanPlan {
  const reminderWindow = reminderWindowFor(args)
  const horizon = args.horizonDays ?? UPCOMING_HORIZON_DAYS
  const every = args.fullEveryMs ?? FULL_SCAN_EVERY_MS
  const full = args.force === true || args.lastFullScanAt <= 0 || args.now - args.lastFullScanAt >= every
  const days = full ? Math.max(horizon, reminderWindow) : reminderWindow
  return { reminderWindow, full, from: args.todayKey, until: days >= 0 ? addDaysKey(args.todayKey, days) : null }
}
