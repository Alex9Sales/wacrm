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
// · janela de horário · carência de 30 min do aviso de cobrança nova (17/09)
// · teto do dia · cadência. Antes de mandar, o executor
// confere se o devedor não foi parado (pausa, promessa, comprovante) e
// reconfere no Asaas se ainda há parcela aberta (executeOrchestrationAction) —
// quem pagou ou foi parado entre a fila e o envio não recebe cobrança.
// ============================================================
import { and, asc, eq, gte, or, sql } from 'drizzle-orm'

import { db, agentActionRequests } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { executeOrchestrationAction, recordCollectionTouch } from '@/lib/orchestration/actions'
import { getAccountSettings } from '@/lib/settings/account-settings'

import { findDeliveredWhatsAppCopy } from './delivered-copy'
import { channelHaltReason, collectionChannelBlocked, handleCollectionChannelFailure } from './channel-halt'
import { localParts } from './engine'
import { newChargeGraceCutoffIso } from './new-charge-rules'
import { autoSendDue, dayBlockedReason, isFinalCollectionError, normalizeSettings, retryCutoffIso, withinWindow } from './rules'
import { expireStaleCollectionDrafts, localDayKey } from './stale'

/** Tentativas antes de marcar o pedido como falho (rede/canal fora do ar). */
const MAX_ATTEMPTS = 3

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
  const hojeKey = localDayKey(tz, now)
  const diaBloqueado = dayBlockedReason(weekday, s, hojeKey)
  if (diaBloqueado) return { ...stats, haltedBecause: diaBloqueado.toLowerCase() }
  if (!withinWindow(hour, weekday, s, hojeKey)) return { ...stats, haltedBecause: 'fora do horário da régua' }
  // 🛑 Número fora do ar: não tenta (cada tentativa numa sessão caída é mais um
  // sinal ruim para o WhatsApp). Os pedidos ficam na fila para quando voltar.
  const canal = await collectionChannelBlocked(accountId, s)
  if (!canal.ok) return { ...stats, haltedBecause: canal.reason }

  // A fila: aprovadas em lote ('queued') e as automáticas ainda não enviadas.
  // Mais antiga primeiro — a régua já ordenou do mais atrasado pro menos.
  // Quem falhou há menos de 3 min fica de fora da vez (o eco pode estar
  // chegando, ver abaixo) sem travar os outros devedores.
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
          sql`(${agentActionRequests.payload}->>'lastAttemptAt' IS NULL OR (${agentActionRequests.payload}->>'lastAttemptAt')::timestamptz <= ${retryCutoffIso(now.getTime())}::timestamptz)`,
          // 🔗 Carência do aviso de cobrança nova (17/09, GoLink): o João cria a
          // cobrança no painel do Asaas e cola o link à mão minutos depois. Sem
          // esperar, o aviso podia sair antes do eco da mensagem dele e o cliente
          // recebia o link duas vezes. Passados 30 min, o executor confere se o
          // link já chegou. Filtro (não espera): os outros pedidos seguem a vez.
          sql`(${agentActionRequests.payload}->>'kind' IS DISTINCT FROM 'new_charge' OR ${agentActionRequests.createdAt} <= ${newChargeGraceCutoffIso(now.getTime())}::timestamptz)`,
        ),
      )
      .orderBy(asc(agentActionRequests.createdAt))
      .limit(1),
  )
  if (!row) return stats

  // 🔁 A tentativa anterior falhou. "Falhou" não quer dizer "não chegou": em
  // 14/09 o WAHA devolveu erro, ENTREGOU, e o reenvio do minuto seguinte deu ao
  // devedor a mesma cobrança duas vezes. Então: o pedido só volta depois de 3
  // min (filtro acima) e, se a mensagem já está na conversa, adota o envio em
  // vez de repetir.
  if ((row.attempts ?? 0) > 0) {
    const prev = (row.payload ?? {}) as Record<string, unknown>
    const copy = await findDeliveredWhatsAppCopy(accountId, row)
    if (copy) {
      const nowIso = now.toISOString()
      await db
        .update(agentActionRequests)
        .set({
          status: 'sent',
          // A hora em que ela chegou de verdade: é o que o teto e a cadência contam.
          executedAt: copy.createdAt ?? nowIso,
          resolvedAt: nowIso,
          resolvedBy: row.resolvedBy ?? null,
          result: { messageId: null, conversationId: copy.conversationId, sentVia: ['whatsapp'], label: 'WhatsApp', adoptedFromEcho: copy.id },
          payload: { ...prev, auto: row.status === 'pending', sentBy: 'sender' },
          error: null,
        })
        .where(eq(agentActionRequests.id, row.id))
      try {
        await recordCollectionTouch(accountId, row.contactId, (row.suggestedText ?? '').trim(), prev.kind)
      } catch (err) {
        console.error('[cobranca-sender] toque do envio adotado não foi registrado:', err instanceof Error ? err.message : err)
      }
      console.log(`[cobranca-sender] ${accountId.slice(0, 8)}: pedido ${row.id.slice(0, 8)} já tinha chegado (mensagem ${copy.id.slice(0, 8)}) — não reenviado`)
      stats.sent = 1
      return stats
    }
  }

  // Teto do dia e cadência olham TODO envio de cobrança da conta (automático
  // ou aprovado à mão): o anti-ban é por linha de WhatsApp, não por origem.
  // O teto é POR DIA do calendário no fuso da conta, não nas últimas 24 h
  // corridas (12/09): com janela corrida, bater o teto hoje zerava a manhã de
  // amanhã. A CADÊNCIA continua olhando o último envio, sem recorte de dia.
  const recent = firstOrNull(
    await db
      .select({
        n: sql<number>`count(*) FILTER (WHERE to_char(${agentActionRequests.executedAt} AT TIME ZONE ${tz}, 'YYYY-MM-DD') = ${hojeKey})::int`,
        last: sql<string | null>`max(${agentActionRequests.executedAt})`,
      })
      .from(agentActionRequests)
      .where(
        and(
          eq(agentActionRequests.accountId, accountId),
          eq(agentActionRequests.actionType, 'collect_charges'),
          eq(agentActionRequests.status, 'sent'),
          gte(agentActionRequests.executedAt, new Date(now.getTime() - 48 * 3_600_000).toISOString()),
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
  // 🛑 A culpa é do CANAL, não deste devedor: marca o número como fora do ar,
  // avisa o dono e devolve o pedido à fila SEM gastar tentativa — a rodada
  // seguinte nem começa enquanto o número não voltar (channel-halt.ts).
  const halt = channelHaltReason(error)
  if (halt) {
    await handleCollectionChannelFailure({ accountId, reason: halt, error, settings: s })
    await db
      .update(agentActionRequests)
      .set({ error, payload: { ...payload, lastAttemptAt: nowIso } })
      .where(eq(agentActionRequests.id, row.id))
    return { ...stats, failed: 1, haltedBecause: 'número fora do ar — a régua parou até ele voltar' }
  }
  const attempts = (row.attempts ?? 0) + 1
  // Pagou entre a fila e o envio (ou a parcela sumiu), ou o devedor foi parado
  // nesse meio-tempo (pausa, promessa, comprovante): não é falha, é o sistema
  // funcionando — encerra o pedido em vez de tentar de novo (rules.ts).
  const gone = isFinalCollectionError(error)
  const final = gone || attempts >= MAX_ATTEMPTS
  await db
    .update(agentActionRequests)
    .set({
      attempts,
      error,
      // Marca a hora da tentativa: o pedido sai da vez por 3 min (retryCutoffIso).
      payload: { ...payload, lastAttemptAt: nowIso },
      ...(final ? { status: gone ? 'expired' : 'failed', resolvedAt: nowIso } : {}),
    })
    .where(eq(agentActionRequests.id, row.id))
  stats.failed = 1
  return stats
}

