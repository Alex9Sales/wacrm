// ============================================================
// Frases da tela do disparo (progresso, pausa, arquivo, chat travado) e a
// regra de excluir × arquivar. PURO (client-safe, sem I/O).
//
// 15/09 (GoLink, Vitor): a tela dizia só "Pausado" e "12 de 40
// processados" — ninguém sabia quando saía o próximo, quem tinha pausado,
// nem por que o link "Chat" dizia "não disponível" (a conversa estava no
// número do Leonardo). E "Excluir" apagava o histórico de quem já tinha
// recebido, sem rastro. Aqui ficam as frases e a regra, testáveis.
// ============================================================

import { hasMinRole, type AccountRole } from '@/lib/auth/roles'

const MIN_MS = 60_000

/** Horário local (HH:MM) no fuso pedido (padrão: o do navegador). */
function hhmm(d: Date, timeZone?: string): string {
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone })
}

function ddmm(d: Date, now: Date, timeZone?: string): string {
  const sameYear =
    d.toLocaleDateString('pt-BR', { year: 'numeric', timeZone }) ===
    now.toLocaleDateString('pt-BR', { year: 'numeric', timeZone })
  return d.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: sameYear ? undefined : 'numeric',
    timeZone,
  })
}

function sameLocalDay(a: Date, b: Date, timeZone?: string): boolean {
  const f = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone })
  return f(a) === f(b)
}

/** "às 10:24" hoje; "em 16/09 às 10:24" em outro dia. */
export function atTime(iso: string, now: Date, timeZone?: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return sameLocalDay(d, now, timeZone)
    ? `às ${hhmm(d, timeZone)}`
    : `em ${ddmm(d, now, timeZone)} às ${hhmm(d, timeZone)}`
}

/** "2 min", "1,5 min", "40 s". */
export function formatInterval(intervalMs: number): string {
  if (intervalMs >= MIN_MS) {
    const min = Math.round((intervalMs / MIN_MS) * 10) / 10
    return `${min.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} min`
  }
  return `${Math.max(1, Math.round(intervalMs / 1000))} s`
}

/** "Atendimento (Leonardo)" — nome do número com a pessoa dona, quando houver. */
export function channelWithOwner(
  channelName: string | null | undefined,
  ownerName: string | null | undefined,
): string | null {
  if (!channelName) return null
  return ownerName ? `${channelName} (${ownerName})` : channelName
}

export interface ProgressLineInput {
  status: string
  pendingCount: number
  /** Menor horário gravado entre os pendentes. */
  nextSlotAt: string | null
  /** Maior horário gravado entre os pendentes. */
  lastSlotAt: string | null
  /** Intervalo entre envios (ms). 0 = sem ritmo conhecido (rajada/template). */
  intervalMs: number
  /** Gotejamento no horário comercial (pacing gravado). */
  drip: boolean
  now: Date
  timeZone?: string
}

/**
 * "Próximo envio às 10:30 · 1 a cada 2 min · termina por volta de 11:48".
 * Pausado não diz horário (os pendentes ganham horários novos ao retomar).
 * null quando não há o que dizer (ninguém pendente).
 */
export function broadcastProgressLine(i: ProgressLineInput): string | null {
  if (i.pendingCount <= 0) return null
  const every =
    i.intervalMs > 0
      ? `1 a cada ${formatInterval(i.intervalMs)}${i.drip ? ' no horário comercial' : ''}`
      : null

  if (i.status === 'paused') {
    const left = i.pendingCount === 1 ? 'Falta 1 envio' : `Faltam ${i.pendingCount} envios`
    return every ? `${left} · ao retomar, ${every} a partir daquele momento` : left
  }
  if (i.status !== 'sending' && i.status !== 'scheduled') return null

  const parts: string[] = []
  const nowMs = i.now.getTime()
  if (i.nextSlotAt) {
    const next = Date.parse(i.nextSlotAt)
    if (Number.isFinite(next)) {
      // Até 30 s de folga: o job já venceu ou está na fila do limitador.
      parts.push(next <= nowMs + 30_000 ? 'Próximo envio agora' : `Próximo envio ${atTime(i.nextSlotAt, i.now, i.timeZone)}`)
    }
  }
  if (every) parts.push(every)
  if (i.lastSlotAt && i.pendingCount > 1) {
    const last = Date.parse(i.lastSlotAt)
    if (Number.isFinite(last) && last > nowMs) {
      const d = new Date(last)
      parts.push(
        sameLocalDay(d, i.now, i.timeZone)
          ? `termina por volta de ${hhmm(d, i.timeZone)}`
          : `termina em ${ddmm(d, i.now, i.timeZone)} por volta de ${hhmm(d, i.timeZone)}`,
      )
    }
  }
  if (parts.length === 0) {
    return i.pendingCount === 1 ? 'Falta 1 envio' : `Faltam ${i.pendingCount} envios`
  }
  return parts.join(' · ')
}

export type BroadcastPauseReason = 'manual' | 'reputation' | 'session'

/**
 * "Pausado por Vitor às 10:24" / "Pausado automaticamente: …". Linha antiga
 * (antes da migração 0173) não tem rastro → só "Pausado".
 */
export function pauseLine(i: {
  pausedByName: string | null | undefined
  pausedAt: string | null | undefined
  pauseReason: string | null | undefined
  now: Date
  timeZone?: string
}): string {
  const when = i.pausedAt ? atTime(i.pausedAt, i.now, i.timeZone) : ''
  const suffix = when ? ` ${when}` : ''
  if (i.pauseReason === 'reputation') {
    return `Pausado automaticamente${suffix}: o WhatsApp começou a recusar os envios deste número (bloqueio por reputação).`
  }
  if (i.pauseReason === 'session') {
    return `Pausado automaticamente${suffix}: a conexão do WhatsApp deste número caiu.`
  }
  if (i.pausedByName) return `Pausado por ${i.pausedByName}${suffix}`
  return `Pausado${suffix}`
}

/** "Arquivado por Vitor em 15/09". */
export function archivedLine(i: {
  archivedByName: string | null | undefined
  archivedAt: string
  now: Date
  timeZone?: string
}): string {
  const d = new Date(i.archivedAt)
  const date = Number.isFinite(d.getTime()) ? ` em ${ddmm(d, i.now, i.timeZone)}` : ''
  return i.archivedByName ? `Arquivado por ${i.archivedByName}${date}` : `Arquivado${date}`
}

const SENT_STATUSES = new Set(['sent', 'delivered', 'read', 'replied'])

/**
 * Dica do cadeado no "Chat" de um destinatário cuja conversa a pessoa não
 * pode abrir. Antes era só "não disponível" — parecia que o envio falhou.
 */
export function lockedChatHint(i: {
  recipientStatus: string
  channelName: string | null | undefined
  holderName: string | null | undefined
}): string {
  const prefix = SENT_STATUSES.has(i.recipientStatus) ? 'Enviado ✓ — a conversa' : 'A conversa'
  const where = channelWithOwner(i.channelName, i.holderName)
  const place = where ? `está no número ${where}` : 'está com outra pessoa'
  return `${prefix} ${place}. Peça a um admin pra atribuir a você.`
}

/** Quem pode excluir/arquivar: quem criou o disparo ou supervisor para cima. */
export function canManageBroadcast(i: {
  actorUserId: string | null | undefined
  actorRole: AccountRole | null | undefined
  creatorUserId: string | null | undefined
}): boolean {
  if (i.actorRole && hasMinRole(i.actorRole, 'supervisor')) return true
  return !!i.actorUserId && !!i.creatorUserId && i.actorUserId === i.creatorUserId
}

