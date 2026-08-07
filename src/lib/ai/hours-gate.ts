// ============================================================
// Horário de atendimento da IA — a IA (Agente ou nó de fluxo) só responde
// conforme o modo escolhido, REUSANDO o horário de atendimento da conta
// (Config → Atendimento: fuso + dias + janela). Modos:
//   · always  — responde sempre (padrão).
//   · inside  — só DENTRO do horário de atendimento.
//   · outside — só FORA do horário (ex.: empresa fechada, fim de semana).
// Fail-open: se o horário de atendimento não estiver configurado na conta,
// não dá pra gatear → a IA responde (nunca fica muda por config faltando).
// ============================================================
import type { AccountSettings } from '@/lib/settings/account-settings'
import { isWithinBusinessHours } from '@/lib/settings/business-hours'

export type AiHoursMode = 'always' | 'inside' | 'outside'

/** Normaliza um valor cru (coluna/JSON) para um modo válido. */
export function toAiHoursMode(raw: unknown): AiHoursMode {
  return raw === 'inside' || raw === 'outside' ? raw : 'always'
}

/**
 * True quando a IA PODE responder agora, dado o modo e o horário da conta.
 */
export function aiHoursAllows(
  mode: AiHoursMode | null | undefined,
  settings: Pick<
    AccountSettings,
    'businessHoursEnabled' | 'businessDays' | 'businessTimezone'
  >,
  now: Date = new Date(),
): boolean {
  if (!mode || mode === 'always') return true
  // Sem janela configurada não há como distinguir dentro/fora — responde.
  if (!settings.businessHoursEnabled) return true
  const within = isWithinBusinessHours(settings, now)
  return mode === 'inside' ? within : !within
}
