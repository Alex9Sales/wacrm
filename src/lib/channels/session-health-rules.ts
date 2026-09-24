// ============================================================
// Quando uma sessão WAHA está REALMENTE doente.
//
// 24/09: em 24 horas o monitor deu 72 reinícios — 36 deles em sessões que o
// WhatsApp reportava como WORKING, derrubadas só porque ficaram 30 a 35
// minutos sem atividade. Canal quieto não é canal doente: fora do horário, no
// almoço, num número de pouco volume, meia hora parado é o normal. E cada
// reinício derruba o canal por minutos — e num vínculo frágil leva a sessão
// para FAILED, que é o estado que exige QR novo. A rotina que existia para
// proteger o canal virou a maior causa de queda.
//
// Regra nova: silêncio só levanta suspeita quando é MUITO maior que o normal
// E o canal é daqueles que costumam se mover. Num canal parado há dias,
// reiniciar não conserta nada — só churn.
// ============================================================

/** Silêncio de sessão WORKING a partir do qual vale desconfiar. */
export const ZOMBIE_SILENCE_MS = Number(process.env.SESSION_STALE_MS) || 3 * 60 * 60_000

/** O canal precisa ter se movido dentro desta janela pra valer o reinício. */
export const ACTIVE_CHANNEL_WINDOW_MS = 24 * 60 * 60_000

export type SessionVerdict = 'healthy' | 'down' | 'zombie'

export interface SessionSignals {
  /** Status que o WAHA reporta (WORKING, FAILED, STOPPED, UNREACHABLE…). */
  wahaStatus: string
  /** Há quanto tempo a SESSÃO registrou atividade (null = o WAHA não disse). */
  activityAgeMs: number | null
  /** Há quanto tempo o CANAL trocou mensagem no CRM (null = nunca). */
  trafficAgeMs: number | null
}

/**
 * O veredito sobre a sessão:
 *   'down'    — o WhatsApp não está servindo esta sessão: reiniciar faz sentido.
 *   'zombie'  — diz WORKING mas parou de entregar num canal que costuma andar.
 *   'healthy' — inclui o canal simplesmente quieto, que NÃO se reinicia.
 */
export function sessionVerdict(s: SessionSignals): SessionVerdict {
  if (s.wahaStatus !== 'WORKING') return 'down'

  // Sem saber há quanto tempo a sessão está parada, não há suspeita: WORKING
  // é a palavra do próprio WhatsApp e não se derruba canal por palpite.
  if (s.activityAgeMs === null) return 'healthy'
  if (s.activityAgeMs <= ZOMBIE_SILENCE_MS) return 'healthy'

  // Silêncio longo num canal que também está parado no CRM = canal quieto,
  // não zumbi. Reiniciar aqui é churn pelo churn.
  if (s.trafficAgeMs === null || s.trafficAgeMs > ACTIVE_CHANNEL_WINDOW_MS) return 'healthy'

  return 'zombie'
}

/** Texto curto do motivo, pro log e pro aviso ao dono. */
export function verdictReason(s: SessionSignals, verdict: SessionVerdict): string {
  const min = (ms: number | null) => (ms === null ? 'sem dado' : `${Math.round(ms / 60_000)}min`)
  if (verdict === 'down') return `sessão ${s.wahaStatus}`
  if (verdict === 'zombie')
    return `WORKING mas sem entregar há ${min(s.activityAgeMs)} (canal ativo, última mensagem há ${min(s.trafficAgeMs)})`
  return `WORKING, atividade ${min(s.activityAgeMs)}`
}
