// ============================================================
// Broadcast lifecycle controls: pause / resume / cancel (Phase 5 CORE).
//
// State machine (queue-relevant states only):
//   scheduled ─pause→ paused ─resume→ sending
//   sending   ─pause→ paused ─resume→ sending
//   sending|scheduled|paused ─cancel→ cancelled  (terminal)
//
// The worker reads broadcast.status on every recipient job:
//   cancelled → skip (no send),
//   paused    → moveToDelayed(+15s) so it self-resumes,
//   sending   → send.
// So pause/resume/cancel are just status writes here; the queued jobs
// react to them. `resume` also re-enqueues the dispatch so a broadcast
// that had no recipient jobs yet (e.g. paused while still scheduled) gets
// fanned out. This module is Next-independent.
//
// 15/09 (GoLink): pausar grava QUEM e QUANDO (paused_by/paused_at/
// pause_reason, migr 0173) na mesma transição condicional; retomar/reenviar
// limpam. "Excluir" de disparo que já enviou vira ARQUIVAR
// (deleteOrArchiveBroadcast) — o "dia do cliente" foi excluído e levou junto
// o histórico de quem já tinha recebido.
// ============================================================

import { and, asc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';

import { db, broadcastRecipients, broadcasts, member, notifications } from '@/db';
import { firstOrNull } from '@/db/helpers';
import type { AccountRole } from '@/lib/auth/roles';
import {
  broadcastDeletionMode,
  canManageBroadcast,
  type BroadcastPauseReason,
} from '@/lib/broadcasts/detail-text';
import { loadDefaultChannel } from '@/lib/channels/channels';
import { publishEvent } from '@/lib/events/publish';
import {
  countSentToday,
  inferSpacingMs,
  normalizePacing,
  pacingIntervalMinutes,
  reslotPendingSlots,
  type PacingConfig,
} from '@/lib/whatsapp/drip-schedule';
import type { ChannelHaltReason } from './errors';
import {
  enqueueBroadcastDispatch,
  removeBroadcastDispatchJob,
  removeRecipientJobs,
  rescheduleRecipient,
} from './queues';
import { finalizeBroadcastIfDone } from './broadcast-jobs';

export type BroadcastControlAction = 'pause' | 'resume' | 'cancel';

export interface ControlResult {
  ok: boolean;
  /** New status on success, or the current status on a rejected transition. */
  status: string;
  /** Error code when !ok. */
  code?: 'not_found' | 'invalid_state' | 'reslot_failed';
  message?: string;
  /** Resume/retry: how the pending recipients were re-spaced from now. */
  schedule?: ReslotSummary;
}

/** O ritmo que os pendentes seguem depois de retomar (pra tela dizer). */
export interface ReslotSummary {
  pending: number;
  /** Intervalo entre envios (ms). 0 = rajada escolhida por quem criou. */
  intervalMs: number;
  /** Horário comercial (gotejamento) em vez de intervalo fixo. */
  drip: boolean;
  firstAt: string | null;
  lastAt: string | null;
}

/**
 * 15/09 (GoLink, Vitor): pausar pra "dar um tempo" e retomar soltava DE UMA
 * VEZ tudo o que venceu durante a pausa — 14 imagens em 73 s num disparo de
 * 1 a cada 2 min (risco de ban e cara de spam). Antes de voltar a enviar,
 * os pendentes ganham horários novos a partir de agora, no mesmo ritmo
 * (reslotPendingSlots), e os jobs na fila são reagendados. O worker ainda
 * confere o horário gravado antes de mandar (job que estava travado e não
 * deu pra reagendar espera o seu horário).
 *
 * `rescheduleJobs: false` quando quem chama vai refazer o dispatch (retry),
 * que enfileira todo mundo já com os horários novos.
 */
export async function reslotPendingRecipients(
  broadcastId: string,
  opts: { rescheduleJobs?: boolean } = {},
): Promise<ReslotSummary> {
  const b = firstOrNull(
    await db
      .select({ pacing: broadcasts.pacing, channelId: broadcasts.channelId })
      .from(broadcasts)
      .where(eq(broadcasts.id, broadcastId))
      .limit(1),
  );
  const empty: ReslotSummary = { pending: 0, intervalMs: 0, drip: false, firstAt: null, lastAt: null };
  if (!b) return empty;

  const rows = await db
    .select({
      id: broadcastRecipients.id,
      status: broadcastRecipients.status,
      slotAt: broadcastRecipients.scheduledSlotAt,
      sentAt: broadcastRecipients.sentAt,
    })
    .from(broadcastRecipients)
    .where(eq(broadcastRecipients.broadcastId, broadcastId))
    .orderBy(
      sql`${broadcastRecipients.scheduledSlotAt} ASC NULLS LAST`,
      asc(broadcastRecipients.createdAt),
      asc(broadcastRecipients.id),
    );
  const pending = rows.filter((r) => r.status === 'pending');
  const toMs = (v: string | null) => (v ? Date.parse(v) : null);
  const pacing: PacingConfig | null = b.pacing ? normalizePacing(b.pacing as Partial<PacingConfig>) : null;
  const intervalMs = pacing ? pacingIntervalMinutes(pacing) * 60_000 : inferSpacingMs(rows.map((r) => toMs(r.slotAt)));
  const sentTimes = rows.map((r) => toMs(r.sentAt)).filter((t): t is number => t !== null && Number.isFinite(t));
  const nowMs = Date.now();

  const slots = reslotPendingSlots({
    pendingCount: pending.length,
    pacing,
    spacingMs: intervalMs,
    lastSentAtMs: sentTimes.length ? Math.max(...sentTimes) : null,
    nowMs,
    usedToday: pacing ? countSentToday(sentTimes, nowMs, pacing.offsetMin) : 0,
  });
  if (!slots || pending.length === 0) {
    return { ...empty, pending: pending.length, intervalMs, drip: !!pacing };
  }
  if (slots.length < pending.length) {
    throw new Error(`reslot incompleto: ${slots.length} horários para ${pending.length} pendentes`);
  }

  // Um UPDATE por lote (VALUES), só em quem continua pendente.
  const BATCH = 500;
  for (let i = 0; i < pending.length; i += BATCH) {
    const values = pending
      .slice(i, i + BATCH)
      .map((r, j) => sql`(${r.id}::uuid, ${new Date(slots[i + j]).toISOString()}::timestamptz)`);
    await db.execute(sql`
      UPDATE "broadcast_recipients" AS r
      SET "scheduled_slot_at" = v.slot
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, slot)
      WHERE r."id" = v.id AND r."status" = 'pending'
    `);
  }

  if (opts.rescheduleJobs !== false && b.channelId) {
    for (let i = 0; i < pending.length; i++) {
      await rescheduleRecipient(b.channelId, broadcastId, pending[i].id, Math.max(0, slots[i] - nowMs));
    }
  }

  return {
    pending: pending.length,
    intervalMs,
    drip: !!pacing,
    firstAt: new Date(slots[0]).toISOString(),
    lastAt: new Date(slots[slots.length - 1]).toISOString(),
  };
}

async function currentStatus(
  broadcastId: string,
  accountId: string,
): Promise<string | null> {
  const row = firstOrNull(
    await db
      .select({ status: broadcasts.status })
      .from(broadcasts)
      .where(
        and(eq(broadcasts.id, broadcastId), eq(broadcasts.accountId, accountId)),
      )
      .limit(1),
  );
  return row?.status ?? null;
}

const STATUS_PT: Record<string, string> = {
  cancelled: 'cancelado',
  paused: 'pausado',
  sent: 'enviado',
  failed: 'com falha',
  sending: 'enviando',
  scheduled: 'agendado',
  draft: 'rascunho',
};
const statusPt = (s: string | null) => (s ? STATUS_PT[s] ?? s : 'desconhecido');

/** Voltou a enviar: a pausa deixa de valer (a tela para de dizer "Pausado por…"). */
const CLEAR_PAUSE = { pausedBy: null, pausedAt: null, pauseReason: null };

/** Encerrados: nada mais sai (cancelar não se aplica). */
const FINAL_STATUSES = ['sent', 'failed', 'cancelled'] as const;
/** Ainda podem enviar alguém. */
const ACTIVE_STATUSES = ['sending', 'scheduled', 'paused'] as const;

/** UPDATE só se o status ainda for `from`. true = esta chamada fez a transição. */
async function transitionStatus(
  broadcastId: string,
  accountId: string,
  from: string,
  to: string,
  extra: Partial<typeof broadcasts.$inferInsert> = {},
): Promise<boolean> {
  const rows = await db
    .update(broadcasts)
    .set({ ...extra, status: to, updatedAt: new Date().toISOString() })
    .where(
      and(eq(broadcasts.id, broadcastId), eq(broadcasts.accountId, accountId), eq(broadcasts.status, from)),
    )
    .returning({ id: broadcasts.id });
  return rows.length > 0;
}

/**
 * Pause a broadcast — only from 'sending' or 'scheduled'. Quem pausou e
 * quando vão na MESMA transição condicional (um Cancelar/fechamento do
 * worker que chegou antes vence e nada é gravado). `actorUserId` null =
 * sem pessoa conhecida (chave de API de quem saiu da conta).
 */
export async function pauseBroadcast(
  broadcastId: string,
  accountId: string,
  actorUserId: string | null = null,
): Promise<ControlResult> {
  const nowIso = new Date().toISOString();
  const won = await db
    .update(broadcasts)
    .set({
      status: 'paused',
      pausedBy: actorUserId,
      pausedAt: nowIso,
      pauseReason: 'manual' satisfies BroadcastPauseReason,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(broadcasts.id, broadcastId),
        eq(broadcasts.accountId, accountId),
        inArray(broadcasts.status, ['sending', 'scheduled']),
      ),
    )
    .returning({ id: broadcasts.id });
  if (won.length > 0) return { ok: true, status: 'paused' };

  const status = await currentStatus(broadcastId, accountId);
  if (status === null)
    return { ok: false, status: 'unknown', code: 'not_found' };
  return {
    ok: false,
    status,
    code: 'invalid_state',
    message: `Não dá pra pausar: o disparo está ${statusPt(status)}.`,
  };
}

/**
 * Resume a paused broadcast → 'sending'. Re-enqueues the dispatch so any
 * recipients not yet fanned out get queued; recipient jobs already sitting
 * delayed (paused self-defer) resume once they see status 'sending'.
 */
export async function resumeBroadcast(
  broadcastId: string,
  accountId: string,
): Promise<ControlResult> {
  const status = await currentStatus(broadcastId, accountId);
  if (status === null)
    return { ok: false, status: 'unknown', code: 'not_found' };
  if (status !== 'paused') {
    return {
      ok: false,
      status,
      code: 'invalid_state',
      message: `Cannot resume a broadcast in status '${status}'`,
    };
  }
  // Ritmo recomeça a partir de agora ANTES de liberar o envio. Se não der
  // pra reorganizar, não retoma: retomar sem isso despeja a fila.
  let schedule: ReslotSummary;
  try {
    schedule = await reslotPendingRecipients(broadcastId);
  } catch (err) {
    console.error('[broadcast-controls] reslot on resume failed:', broadcastId, err);
    return {
      ok: false,
      status,
      code: 'reslot_failed',
      message: 'Não consegui reorganizar os horários dos próximos envios. Tente retomar de novo em instantes.',
    };
  }
  // Transição condicional: um Cancelar/Pausar que chegou durante o reslot
  // vence (revisão 15/09) — senão o disparo cancelado voltava a enviar.
  const won = await transitionStatus(broadcastId, accountId, 'paused', 'sending', CLEAR_PAUSE);
  if (!won) {
    const now = await currentStatus(broadcastId, accountId);
    // Outra ação (outro Retomar, "Enviar agora") já voltou a enviar: não é erro.
    if (now !== 'sending') {
      return {
        ok: false,
        status: now ?? 'unknown',
        code: 'invalid_state',
        message: `O disparo ficou ${statusPt(now)} enquanto retomava.`,
      };
    }
  }
  // Re-enqueue dispatch (jobId dedups if one is still around) so any
  // still-pending recipients are (re)fanned out.
  await enqueueBroadcastDispatch(broadcastId, {});
  // O dispatch re-enfileirado costuma ser deduplicado: se não sobrou
  // pendente (o último saiu durante a pausa), fecha o disparo aqui.
  await finalizeBroadcastIfDone(broadcastId);
  return { ok: true, status: 'sending', schedule };
}

/** Cancel a broadcast → 'cancelled' (terminal). Pending recipients won't
 *  send: their jobs see 'cancelled' and skip. Blocked once already
 *  sent/failed/cancelled. */
export async function cancelBroadcast(
  broadcastId: string,
  accountId: string,
): Promise<ControlResult> {
  // Transição condicional (15/09): o worker fechando o disparo ('sent') no
  // mesmo instante vence — antes o UPDATE incondicional sobrescrevia.
  const won = await db
    .update(broadcasts)
    .set({ status: 'cancelled', updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(broadcasts.id, broadcastId),
        eq(broadcasts.accountId, accountId),
        notInArray(broadcasts.status, [...FINAL_STATUSES]),
      ),
    )
    .returning({ id: broadcasts.id });
  if (won.length > 0) return { ok: true, status: 'cancelled' };

  const status = await currentStatus(broadcastId, accountId);
  if (status === null)
    return { ok: false, status: 'unknown', code: 'not_found' };
  return {
    ok: false,
    status,
    code: 'invalid_state',
    message: `Não dá pra cancelar: o disparo já está ${statusPt(status)}.`,
  };
}

/**
 * Requeue only the FAILED recipients of a finished (or stuck) broadcast —
 * "reenviar falhados". Resets them to 'pending' (attempts zeroed, error
 * cleared), flips the broadcast back to 'sending' and re-enqueues the
 * dispatch, which fans out pending recipients only (already-sent ones are
 * untouched). Typical use: a channel dropped mid-broadcast and reconnected.
 */
export async function retryFailedBroadcast(
  broadcastId: string,
  accountId: string,
): Promise<ControlResult & { requeued?: number }> {
  const row = firstOrNull(
    await db
      .select({ status: broadcasts.status, channelId: broadcasts.channelId, archivedAt: broadcasts.archivedAt })
      .from(broadcasts)
      .where(
        and(eq(broadcasts.id, broadcastId), eq(broadcasts.accountId, accountId)),
      )
      .limit(1),
  );
  if (!row) return { ok: false, status: 'unknown', code: 'not_found' };
  const status = row.status;
  // Arquivado fica só como histórico (15/09): reenviar reabriria um disparo
  // que alguém tirou da lista de propósito.
  if (row.archivedAt) {
    return { ok: false, status, code: 'invalid_state', message: 'Este disparo está arquivado — crie um novo pra enviar de novo.' };
  }
  if (status === 'scheduled') {
    return {
      ok: false,
      status,
      code: 'invalid_state',
      message: `Broadcast ainda agendado ('${status}')`,
    };
  }
  // Reset failed → pending, then re-fan ALL pending (failed just reset +
  // any that got stuck) — covers a channel drop mid-broadcast.
  await db
    .update(broadcastRecipients)
    .set({ status: 'pending', attempts: 0, errorMessage: null })
    .where(
      and(
        eq(broadcastRecipients.broadcastId, broadcastId),
        eq(broadcastRecipients.status, 'failed'),
      ),
    );
  const pending = await db
    .select({ id: broadcastRecipients.id })
    .from(broadcastRecipients)
    .where(
      and(
        eq(broadcastRecipients.broadcastId, broadcastId),
        eq(broadcastRecipients.status, 'pending'),
      ),
    );
  if (pending.length === 0) {
    return {
      ok: false,
      status,
      code: 'invalid_state',
      message: 'Nenhum destinatário pendente/falhado para reenviar',
    };
  }
  // Mesmo ritmo a partir de agora (senão os reenviados + vencidos saem de
  // uma vez — pior ainda depois de um bloqueio 463). O dispatch abaixo
  // enfileira todos já com os horários novos.
  let schedule: ReslotSummary | undefined;
  try {
    schedule = await reslotPendingRecipients(broadcastId, { rescheduleJobs: false });
  } catch (err) {
    // Sem os horários novos segue como antes (não deixa ninguém sem job).
    console.error('[broadcast-controls] reslot on retry failed:', broadcastId, err);
  }
  // Clear the BullMQ jobId dedup: a completed dispatch job and prior
  // failed recipient jobs block the re-enqueue otherwise.
  await removeBroadcastDispatchJob(broadcastId);
  if (row.channelId) {
    await removeRecipientJobs(
      row.channelId,
      pending.map((p) => p.id),
    );
  }
  let won = await transitionStatus(broadcastId, accountId, status, 'sending', CLEAR_PAUSE);
  if (!won) {
    const now = await currentStatus(broadcastId, accountId);
    if (now === 'sent' || now === 'failed') {
      // O worker fechou o disparo no meio (último pendente saiu): reabre, senão
      // os reenviados ficariam 'pending' sem job e sem botão pra recuperar.
      won = await transitionStatus(broadcastId, accountId, now, 'sending', CLEAR_PAUSE);
    } else if (now === 'sending') {
      won = true; // outro Reenviar/Retomar venceu: re-enfileirar é idempotente
    }
    if (!won) {
      return {
        ok: false,
        status: now ?? 'unknown',
        code: 'invalid_state',
        message: `O disparo ficou ${statusPt(now)} enquanto reenviava.`,
      };
    }
  }
  await enqueueBroadcastDispatch(broadcastId, {});
  return { ok: true, status: 'sending', requeued: pending.length, schedule };
}

/** broadcasts.pause_reason gravado numa pausa automática. */
function haltPauseReason(reason: ChannelHaltReason): BroadcastPauseReason {
  return reason === 'reputation' ? 'reputation' : 'session';
}

/** What the operator sees when a broadcast is auto-paused. */
function haltAlert(
  reason: ChannelHaltReason,
  broadcastName: string,
): { title: string; body: string } {
  if (reason === 'reputation') {
    return {
      title: 'Disparo pausado — número bloqueado pelo WhatsApp',
      body:
        `Pausei "${broadcastName}" automaticamente: o WhatsApp começou a recusar os envios ` +
        `desse número por reputação (erro 463). Insistir piora e pode banir o número de vez. ` +
        `Deixe-o descansar e aqueça-o antes de continuar — ou siga por outro número. ` +
        `Quando estiver liberado, use "Reenviar falhados".`,
    };
  }
  return {
    title: 'Disparo pausado — canal desconectado',
    body:
      `Pausei "${broadcastName}" automaticamente: a sessão do WhatsApp desse canal caiu ` +
      `(deslogada ou fora do ar), então nada mais sairia. Reconecte o canal e use ` +
      `"Reenviar falhados" para retomar de onde parou.`,
  };
}

/**
 * Auto-pause a broadcast because the CHANNEL is in trouble (reputation block /
 * session down) and alert its owner. Called by the worker on the first such
 * failure — every remaining recipient would fail anyway, and with a 463 each
 * extra attempt burns the sender number further.
 *
 * Race-safe by construction: the pause is a conditional UPDATE on
 * `status = 'sending'`, so of N recipient jobs failing at once exactly ONE
 * flips the status and raises the alert — the rest get `false` and stay quiet.
 * Their queued jobs then see 'paused' and defer themselves, so the broadcast
 * stops without losing anyone: the pending recipients keep their slot and a
 * later "Reenviar falhados" picks the failed ones back up.
 *
 * Returns true when THIS call did the pausing (and alerted).
 */
export async function haltBroadcast(
  broadcastId: string,
  reason: ChannelHaltReason,
  detail: string,
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const won = firstOrNull(
    await db
      .update(broadcasts)
      .set({
        status: 'paused',
        // Pausa automática: sem pessoa, com o motivo (a tela diz qual).
        pausedBy: null,
        pausedAt: nowIso,
        pauseReason: haltPauseReason(reason),
        updatedAt: nowIso,
      })
      .where(
        and(eq(broadcasts.id, broadcastId), eq(broadcasts.status, 'sending')),
      )
      .returning({
        accountId: broadcasts.accountId,
        userId: broadcasts.userId,
        name: broadcasts.name,
      }),
  );
  // Lost the race (someone already paused/finished it) → don't double-alert.
  if (!won) return false;

  // Alerting must never break the pause — the pause is the part that protects
  // the number.
  try {
    const { title, body } = haltAlert(reason, won.name);
    await db.insert(notifications).values({
      accountId: won.accountId,
      userId: won.userId,
      type: 'broadcast_halted',
      title,
      body: `${body}\n\nErro: ${detail.slice(0, 300)}`,
    });
    await publishEvent(won.accountId, { type: 'notification' });
  } catch (err) {
    console.error('[broadcast-controls] halt alert failed:', err);
  }
  return true;
}

export async function controlBroadcast(
  action: BroadcastControlAction,
  broadcastId: string,
  accountId: string,
  actorUserId: string | null = null,
): Promise<ControlResult> {
  switch (action) {
    case 'pause':
      return pauseBroadcast(broadcastId, accountId, actorUserId);
    case 'resume':
      return resumeBroadcast(broadcastId, accountId);
    case 'cancel':
      return cancelBroadcast(broadcastId, accountId);
  }
}

// ------------------------------------------------------------
// Excluir × arquivar (15/09, GoLink): o "dia do cliente" foi excluído depois
// de já ter saído pra dezenas de pessoas — sumiu o histórico de quem recebeu
// e ninguém sabia quem clicou. Agora:
//   - só quem criou ou supervisor+ (canManageBroadcast);
//   - ativo (enviando/agendado/pausado) é CANCELADO antes, na transição
//     condicional, e os jobs que ainda não rodaram saem da fila;
//   - já saiu pra alguém (enviado OU tentado) → ARQUIVA (some da lista, os
//     destinatários e as contagens ficam); nunca saiu → apaga de verdade.
// ------------------------------------------------------------

export interface BroadcastActor {
  userId: string | null;
  /** null = sem papel conhecido (ex.: chave de API de quem saiu da conta). */
  role: AccountRole | null;
}

export type DeleteBroadcastResult =
  | {
      ok: true;
      archived: boolean;
      /** Já estava arquivado antes desta chamada (nada mudou). */
      alreadyArchived?: boolean;
      /** Status antes de mexer (pra auditoria). */
      previousStatus: string;
      /** Esta chamada cancelou um disparo que ainda estava ativo. */
      cancelled: boolean;
      sentCount: number;
      channelId: string | null;
    }
  | { ok: false; code: 'not_found' | 'forbidden'; error: string };

/** Papel atual de uma pessoa na conta (null = não é mais membro). */
export async function memberRole(accountId: string, userId: string | null): Promise<AccountRole | null> {
  if (!userId) return null;
  const row = firstOrNull(
    await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, accountId), eq(member.userId, userId)))
      .limit(1),
  );
  return (row?.role as AccountRole | undefined) ?? null;
}

export async function deleteOrArchiveBroadcast(
  broadcastId: string,
  accountId: string,
  actor: BroadcastActor,
): Promise<DeleteBroadcastResult> {
  const b = firstOrNull(
    await db
      .select({
        userId: broadcasts.userId,
        status: broadcasts.status,
        channelId: broadcasts.channelId,
        archivedAt: broadcasts.archivedAt,
        sentCount: broadcasts.sentCount,
      })
      .from(broadcasts)
      .where(and(eq(broadcasts.id, broadcastId), eq(broadcasts.accountId, accountId)))
      .limit(1),
  );
  if (!b) return { ok: false, code: 'not_found', error: 'Disparo não encontrado.' };
  if (!canManageBroadcast({ actorUserId: actor.userId, actorRole: actor.role, creatorUserId: b.userId })) {
    return {
      ok: false,
      code: 'forbidden',
      error: 'Só quem criou o disparo ou um supervisor pode excluir ou arquivar.',
    };
  }
  if (b.archivedAt) {
    return {
      ok: true,
      archived: true,
      alreadyArchived: true,
      previousStatus: b.status,
      cancelled: false,
      sentCount: b.sentCount ?? 0,
      channelId: b.channelId,
    };
  }

  // 1) Para de enviar ANTES de decidir (condicional: um fechamento do worker
  //    que chegou antes vence).
  let cancelled = false;
  if ((ACTIVE_STATUSES as readonly string[]).includes(b.status)) {
    const rows = await db
      .update(broadcasts)
      .set({ status: 'cancelled', updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(broadcasts.id, broadcastId),
          eq(broadcasts.accountId, accountId),
          inArray(broadcasts.status, [...ACTIVE_STATUSES]),
        ),
      )
      .returning({ id: broadcasts.id });
    cancelled = rows.length > 0;
  }

  // 2) Jobs que ainda não rodaram saem da fila (best-effort: um job que
  //    escapar vê 'cancelled' — ou a linha apagada — e não envia).
  try {
    const pending = await db
      .select({ id: broadcastRecipients.id })
      .from(broadcastRecipients)
      .where(and(eq(broadcastRecipients.broadcastId, broadcastId), eq(broadcastRecipients.status, 'pending')));
    await removeBroadcastDispatchJob(broadcastId);
    const channelId = b.channelId ?? (await loadDefaultChannel(accountId))?.id ?? null;
    if (channelId && pending.length > 0) {
      await removeRecipientJobs(channelId, pending.map((p) => p.id));
    }
  } catch (err) {
    console.error('[broadcast-controls] remover jobs ao excluir/arquivar falhou:', broadcastId, err);
  }

  // 3) Nunca saiu pra ninguém → apaga. O próprio DELETE confere de novo
  //    (um envio que terminou entre a leitura e aqui faz cair no arquivar).
  //    ⚠️ Subquery raw: coluna externa como literal "broadcasts"."id".
  const nonPending = firstOrNull(
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(broadcastRecipients)
      .where(and(eq(broadcastRecipients.broadcastId, broadcastId), ne(broadcastRecipients.status, 'pending'))),
  );
  const fresh = firstOrNull(
    await db.select({ sentCount: broadcasts.sentCount }).from(broadcasts).where(eq(broadcasts.id, broadcastId)).limit(1),
  );
  const sentCount = fresh?.sentCount ?? b.sentCount ?? 0;
  if (broadcastDeletionMode({ sentCount, nonPendingCount: nonPending?.n ?? 0 }) === 'delete') {
    const deleted = await db
      .delete(broadcasts)
      .where(
        and(
          eq(broadcasts.id, broadcastId),
          eq(broadcasts.accountId, accountId),
          sql`COALESCE("broadcasts"."sent_count", 0) = 0`,
          sql`NOT EXISTS (SELECT 1 FROM broadcast_recipients r WHERE r.broadcast_id = "broadcasts"."id" AND r.status <> 'pending')`,
        ),
      )
      .returning({ id: broadcasts.id });
    if (deleted.length > 0) {
      return { ok: true, archived: false, previousStatus: b.status, cancelled, sentCount: 0, channelId: b.channelId };
    }
  }

  // 4) Arquiva: some da lista, o histórico fica.
  const nowIso = new Date().toISOString();
  await db
    .update(broadcasts)
    .set({ archivedAt: nowIso, archivedBy: actor.userId, updatedAt: nowIso })
    .where(and(eq(broadcasts.id, broadcastId), eq(broadcasts.accountId, accountId), isNull(broadcasts.archivedAt)));
  return { ok: true, archived: true, previousStatus: b.status, cancelled, sentCount, channelId: b.channelId };
}
