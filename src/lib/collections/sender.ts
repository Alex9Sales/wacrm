// ============================================================
// 🧾 Sender da régua — quem de fato ENVIA a cobrança automática, uma a cada N
// minutos (Cobranças → Ajustar → "Uma mensagem a cada"). A régua (engine.ts)
// só decide e enfileira: pedido com decision='auto' fica 'pending' até este
// sender passar; o "Aprovar todas" de Precisa de você deixa o pedido 'queued'
// (humano já aprovou, texto fechado) e ele também sai por aqui, no mesmo
// ritmo. UMA mensagem por chamada, por conta — o worker chama a cada minuto.
//
// Por que existe (09/09, João/GoLink): "quero automático já" + "cadenciar o
// envio, uma a cada 5 ou 10 minutos, pra evitar banimento". Antes ninguém
// executava o pedido automático da régua (ele nascia pendente e ficava na
// fila), e o lote aprovado saía de uma vez.
//
// Travas, na ordem: régua ligada · freio da conta (IA pausada / só sugestões)
// · janela de horário · teto do dia · cadência. Antes de mandar, o executor
// reconfere no Asaas se ainda há parcela aberta (executeOrchestrationAction) —
// quem pagou entre a fila e o envio não recebe cobrança.
// ============================================================
import { and, asc, eq, gte, or, sql } from 'drizzle-orm'

import { db, agentActionRequests } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { executeOrchestrationAction } from '@/lib/orchestration/actions'
import { getAccountSettings } from '@/lib/settings/account-settings'

import { localParts } from './engine'
import { autoSendDue, normalizeSettings, withinWindow } from './rules'
import { expireStaleCollectionDrafts } from './stale'

/** Tentativas antes de marcar o pedido como falho (rede/canal fora do ar). */
const MAX_ATTEMPTS = 3

/** Recusas que NÃO são falha temporária: o motivo da cobrança sumiu. */
const GONE_RE = /nada em aberto|já foi pag|não está mais|não foi enviada/i

export interface SenderStats {
  sent: number
  failed: number
  /** Havia fila, mas ainda não era hora (cadência/teto). */
  waiting: number
  haltedBecause?: string
}

/**
 * Manda a PRÓXIMA cobrança devida desta conta, se já passou a cadência.
 * Idempotente por construção: um pedido só sai uma vez (vira 'sent'), e o
 * worker roda com concorrência 1.
 */
export async function sendDueAutoCollections(accountId: string, now = new Date()): Promise<SenderStats> {
  const stats: SenderStats = { sent: 0, failed: 0, waiting: 0 }

  const accountSettings = await getAccountSettings(accountId)
  const s = normalizeSettings(accountSettings.collections)
  const tz = accountSettings.businessTimezone || 'America/Sao_Paulo'
  // Rascunho de outro dia nunca sai (stale.ts) — mesmo com a régua desligada a
  // fila não fica mostrando "vence hoje" de ontem; a próxima rodada refaz.
  await expireStaleCollectionDrafts(accountId, tz, now)
  if (!s.enabled) return { ...stats, haltedBecause: 'régua desligada' }
  if (accountSettings.aiMode === 'off' || accountSettings.aiMode === 'suggest' || accountSettings.autonomyPaused) {
    return { ...stats, haltedBecause: 'IA pausada ou só sugerindo nesta conta' }
  }
  const { hour, weekday } = localParts(tz)
  if (!withinWindow(hour, weekday, s)) return { ...stats, haltedBecause: 'fora da janela da régua' }

  // A fila: aprovadas em lote ('queued') e as automáticas ainda não enviadas.
  // Mais antiga primeiro — a régua já ordenou do mais atrasado pro menos.
  const row = firstOrNull(
    await db
      .select()
      .from(agentActionRequests)
      .where(
        and(
          eq(agentActionRequests.accountId, accountId),
          eq(agentActionRequests.actionType, 'collect_charges'),
          or(
            eq(agentActionRequests.status, 'queued'),
            and(eq(agentActionRequests.status, 'pending'), eq(agentActionRequests.decision, 'auto')),
          ),
        ),
      )
      .orderBy(asc(agentActionRequests.createdAt))
      .limit(1),
  )
  if (!row) return stats

  // Teto do dia e cadência olham TODO envio de cobrança da conta (automático
  // ou aprovado à mão): o anti-ban é por linha de WhatsApp, não por origem.
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000).toISOString()
  const recent = firstOrNull(
    await db
      .select({
        n: sql<number>`count(*)::int`,
        last: sql<string | null>`max(${agentActionRequests.executedAt})`,
      })
      .from(agentActionRequests)
      .where(
        and(
          eq(agentActionRequests.accountId, accountId),
          eq(agentActionRequests.actionType, 'collect_charges'),
          eq(agentActionRequests.status, 'sent'),
          gte(agentActionRequests.executedAt, dayAgo),
        ),
      ),
  )
  if ((recent?.n ?? 0) >= s.dailyCap) return { ...stats, waiting: 1, haltedBecause: `teto de ${s.dailyCap} por dia atingido` }
  const lastMs = recent?.last ? new Date(recent.last).getTime() : null
  if (!autoSendDue(lastMs, now.getTime(), s.sendEveryMinutes)) return { ...stats, waiting: 1 }

  const text = (row.suggestedText ?? '').trim()
  const payload = (row.payload ?? {}) as Record<string, unknown>
  const exec = text
    ? await executeOrchestrationAction({
        accountId,
        actorUserId: null,
        agentId: row.agentId,
        action: 'collect_charges',
        contactId: row.contactId,
        dealId: null,
        conversationId: row.conversationId,
        text,
        reason: row.reason ?? 'Cobrança automática da régua.',
        payload,
      })
    : { ok: false as const, error: 'Sem texto pra enviar.' }

  const nowIso = now.toISOString()
  if (exec.ok) {
    await db
      .update(agentActionRequests)
      .set({
        status: 'sent',
        executedAt: nowIso,
        resolvedAt: nowIso,
        // 'queued' guarda quem aprovou; automático de verdade fica sem ninguém.
        resolvedBy: row.resolvedBy ?? null,
        result: exec.result ?? {},
        revertState: exec.revertState ?? null,
        payload: { ...payload, auto: row.status === 'pending', sentBy: 'sender' },
        error: null,
      })
      .where(eq(agentActionRequests.id, row.id))
    stats.sent = 1
    return stats
  }

  const error = (exec.error ?? 'Não deu certo.').slice(0, 500)
  const attempts = (row.attempts ?? 0) + 1
  // Pagou entre a fila e o envio (ou a parcela sumiu): não é falha, é o
  // sistema funcionando — encerra o pedido em vez de tentar de novo.
  const gone = GONE_RE.test(error)
  const final = gone || attempts >= MAX_ATTEMPTS
  await db
    .update(agentActionRequests)
    .set({
      attempts,
      error,
      ...(final ? { status: gone ? 'expired' : 'failed', resolvedAt: nowIso } : {}),
    })
    .where(eq(agentActionRequests.id, row.id))
  stats.failed = 1
  return stats
}
