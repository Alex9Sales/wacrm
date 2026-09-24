// ============================================================
// Saúde do canal Instagram: token vivo, id certo, webhook entregando.
//
// 24/09 (Isabele/Zelo): ela criou a automação de comentário, comentou no
// próprio post e não aconteceu nada. Três defeitos empilhados:
//   1. o token de 60 dias tinha vencido no dia anterior — e o canal continuava
//      escrito "Conectado" na tela, então ninguém tinha como desconfiar;
//   2. ninguém renovava o token (não existia rotina de refresh no código);
//   3. na conexão, o `/me` falhou calado e o callback guardou o id app-scoped
//      (28…) no lugar do id da conta profissional (17841…) — com esse id a
//      inscrição do webhook responde 400 e o webhook que chegasse não acharia
//      o canal.
//
// Este módulo é o lugar onde isso se conserta sozinho: `ensureIgDelivery`
// repara o id, renova o token quando dá, reinscreve o webhook e marca o canal
// como "precisa reconectar" quando o token morreu de vez.
// ============================================================

import { and, eq, inArray } from 'drizzle-orm'

import { db, channels } from '@/db'
import { encryptCredentials, loadChannel } from './channels'
import type { ChannelCtx } from './provider'
import {
  fetchInstagramMe,
  fetchInstagramSubscription,
  isInstagramAuthError,
  refreshInstagramToken,
  subscribeInstagramWebhook,
} from './providers/instagram'

/** Id de conta profissional do Instagram — o único que o webhook usa. */
const PRO_ID_RE = /^17\d{15,}$/

/** A partir de quantos dias de vida restante vale a pena renovar o token. */
export const IG_REFRESH_WHEN_DAYS_LEFT = 20

/** O canal está com um id que o Instagram não aceita em subscribed_apps? */
export function looksLikeAppScopedId(igId: string | null | undefined): boolean {
  return !!igId && !PRO_ID_RE.test(igId)
}

/** Quando o token vence, se soubermos. */
export function igTokenExpiresAt(ch: ChannelCtx): Date | null {
  const raw = (ch.providerMeta as Record<string, unknown>).token_expires_at
  if (typeof raw !== 'string' || !raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Dias que faltam pro token vencer (null = não sabemos). */
export function igTokenDaysLeft(ch: ChannelCtx, now = new Date()): number | null {
  const at = igTokenExpiresAt(ch)
  if (!at) return null
  return Math.floor((at.getTime() - now.getTime()) / 86_400_000)
}

/** Grava pedaços do provider_meta sem apagar o resto. */
async function patchProviderMeta(channelId: string, patch: Record<string, unknown>): Promise<void> {
  const row = await db
    .select({ providerMeta: channels.providerMeta })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1)
  const current = (row[0]?.providerMeta ?? {}) as Record<string, unknown>
  await db
    .update(channels)
    .set({ providerMeta: { ...current, ...patch }, updatedAt: new Date().toISOString() })
    .where(eq(channels.id, channelId))
}

/**
 * O token morreu: marca o canal como desconectado com o motivo à vista, pra
 * tela parar de dizer "Conectado" e o dono saber que precisa reconectar.
 */
export async function markIgChannelExpired(ch: ChannelCtx, reason: string): Promise<void> {
  console.error(`[instagram health] canal ${ch.id} sem token válido: ${reason}`)
  await db
    .update(channels)
    .set({ status: 'disconnected', updatedAt: new Date().toISOString() })
    .where(eq(channels.id, ch.id))
  await patchProviderMeta(ch.id, {
    health: {
      state: 'needs_reconnect',
      reason,
      at: new Date().toISOString(),
    },
  })
}

/** Guarda o token novo (criptografado) + a data de vencimento. */
async function storeRefreshedToken(
  ch: ChannelCtx,
  token: string,
  expiresInSeconds: number | null,
): Promise<void> {
  const credentials = encryptCredentials({ ...ch.credentials, accessToken: token })
  await db.update(channels).set({ credentials, updatedAt: new Date().toISOString() }).where(eq(channels.id, ch.id))
  const expiresAt = expiresInSeconds
    ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
    : null
  await patchProviderMeta(ch.id, {
    ...(expiresAt ? { token_expires_at: expiresAt } : {}),
    health: { state: 'ok', at: new Date().toISOString() },
  })
  // O ctx em memória segue sendo usado nesta mesma chamada.
  ch.credentials.accessToken = token
}

/**
 * Renova o token de 60 dias. Devolve o que aconteceu pra quem chamou poder
 * contar (a rotina do worker loga, a tela mostra).
 */
export async function refreshIgTokenIfNeeded(
  ch: ChannelCtx,
  opts: { force?: boolean } = {},
): Promise<{ renewed: boolean; daysLeft: number | null; error: string | null }> {
  const daysLeft = igTokenDaysLeft(ch)
  if (!opts.force && daysLeft !== null && daysLeft > IG_REFRESH_WHEN_DAYS_LEFT) {
    return { renewed: false, daysLeft, error: null }
  }
  const r = await refreshInstagramToken(ch)
  if (!r.token) {
    if (isInstagramAuthError({ message: r.error ?? '' })) {
      await markIgChannelExpired(ch, r.error ?? 'token vencido')
    }
    return { renewed: false, daysLeft, error: r.error }
  }
  await storeRefreshedToken(ch, r.token, r.expiresInSeconds)
  const newDaysLeft = r.expiresInSeconds ? Math.floor(r.expiresInSeconds / 86_400) : null
  return { renewed: true, daysLeft: newDaysLeft, error: null }
}

export interface IgDeliveryResult {
  ok: boolean
  /** Campos que o Instagram está entregando depois do conserto. */
  fields: string[]
  /** O que ainda falta (vazio quando ok). */
  missing: string[]
  /** Consertamos o ig_id guardado errado? */
  repairedIgId: string | null
  /** Mensagem pronta pra mostrar na tela quando não deu. */
  error: string | null
  /** O token morreu — só reconectando. */
  needsReconnect: boolean
}

/**
 * Garante que o Instagram está entregando comentário e DM neste canal:
 * conserta o id quando está errado, inscreve o webhook e confere o resultado
 * em vez de confiar no 200 (a Meta às vezes aceita o POST e não inscreve).
 */
export async function ensureIgDelivery(ch: ChannelCtx): Promise<IgDeliveryResult> {
  const base: IgDeliveryResult = {
    ok: false,
    fields: [],
    missing: [],
    repairedIgId: null,
    error: null,
    needsReconnect: false,
  }

  // 1) O id guardado serve? O app-scoped (28…) não é aceito em lugar nenhum.
  let repairedIgId: string | null = null
  const igId = (ch.providerMeta as Record<string, unknown>).ig_id
  if (looksLikeAppScopedId(typeof igId === 'string' ? igId : null)) {
    const me = await fetchInstagramMe(ch)
    if (me.userId && !looksLikeAppScopedId(me.userId)) {
      await patchProviderMeta(ch.id, { ig_id: me.userId })
      ch.providerMeta.ig_id = me.userId
      repairedIgId = me.userId
      if (me.username) {
        await db
          .update(channels)
          .set({ name: `Instagram @${me.username}`, updatedAt: new Date().toISOString() })
          .where(eq(channels.id, ch.id))
      }
      console.log(`[instagram health] canal ${ch.id}: ig_id corrigido para ${me.userId}`)
    } else if (me.error) {
      if (isInstagramAuthError({ message: me.error })) {
        await markIgChannelExpired(ch, me.error)
        return { ...base, error: me.error, needsReconnect: true }
      }
      return { ...base, error: me.error }
    }
  }

  // 2) Inscreve.
  const sub = await subscribeInstagramWebhook(ch)
  if (!sub.ok && isInstagramAuthError({ code: sub.errorCode, message: sub.error })) {
    await markIgChannelExpired(ch, sub.error ?? 'token vencido')
    return { ...base, repairedIgId, error: sub.error ?? null, needsReconnect: true }
  }

  // 3) Confere de verdade.
  const check = await fetchInstagramSubscription(ch)
  if (check.error) {
    if (isInstagramAuthError({ code: check.errorCode, message: check.error })) {
      await markIgChannelExpired(ch, check.error)
      return { ...base, repairedIgId, error: check.error, needsReconnect: true }
    }
    return { ...base, repairedIgId, error: check.error }
  }
  if (check.missing.length > 0) {
    return {
      ...base,
      fields: check.fields,
      missing: check.missing,
      repairedIgId,
      error:
        'A Meta aceitou o pedido mas não ativou os comentários. Isso acontece quando a permissão de comentários do app ainda não foi aprovada, ou quando quem conectou a conta não autorizou essa permissão — reconecte o Instagram aceitando todas as permissões.',
    }
  }

  if (ch.providerMeta.health || repairedIgId) {
    await patchProviderMeta(ch.id, { health: { state: 'ok', at: new Date().toISOString() } })
    if (repairedIgId) {
      await db
        .update(channels)
        .set({ status: 'connected', updatedAt: new Date().toISOString() })
        .where(eq(channels.id, ch.id))
    }
  }
  return { ok: true, fields: check.fields, missing: [], repairedIgId, error: null, needsReconnect: false }
}

// ------------------------------------------------------------
// 🩺 Ronda periódica (roda junto do monitor dos canais Meta).
// ------------------------------------------------------------

/** Espera pelo menos isto entre duas rondas completas do mesmo canal. */
const FULL_CHECK_EVERY_MS = 12 * 60 * 60_000

export interface IgHealthTickResult {
  checked: number
  refreshed: number
  repaired: number
  down: number
}

function lastCheckedAt(meta: Record<string, unknown>): number {
  const health = meta.health as { checked_at?: string } | undefined
  const at = health?.checked_at ? Date.parse(health.checked_at) : NaN
  return Number.isNaN(at) ? 0 : at
}

/**
 * Passa por todo canal de Instagram: renova o token que está perto de vencer,
 * conserta o id guardado errado e reinscreve o webhook. Sem isso, um canal
 * morre calado a cada 60 dias mostrando "Conectado" na tela.
 */
export async function runInstagramHealthCheck(now = Date.now()): Promise<IgHealthTickResult> {
  const result: IgHealthTickResult = { checked: 0, refreshed: 0, repaired: 0, down: 0 }
  let rows: { id: string; providerMeta: unknown }[]
  try {
    rows = await db
      .select({ id: channels.id, providerMeta: channels.providerMeta })
      .from(channels)
      .where(
        and(
          eq(channels.provider, 'instagram'),
          inArray(channels.status, ['connected', 'error', 'disconnected']),
        ),
      )
  } catch (err) {
    console.error('[instagram health] load channels failed:', err)
    return result
  }

  for (const row of rows) {
    const meta = (row.providerMeta ?? {}) as Record<string, unknown>
    const igId = typeof meta.ig_id === 'string' ? meta.ig_id : null
    const needsRepair = meta.ig_id_provisional === true || looksLikeAppScopedId(igId)
    // Sem nada a consertar, uma ronda por canal a cada 12h já basta — cada
    // passada gasta chamadas de API da conta do cliente.
    if (!needsRepair && now - lastCheckedAt(meta) < FULL_CHECK_EVERY_MS) continue

    const ch = await loadChannel(row.id)
    if (!ch) continue
    result.checked++
    try {
      const refresh = await refreshIgTokenIfNeeded(ch)
      if (refresh.renewed) result.refreshed++

      const delivery = await ensureIgDelivery(ch)
      if (delivery.repairedIgId) result.repaired++
      if (delivery.needsReconnect) result.down++
      await patchProviderMeta(row.id, {
        ...(meta.ig_id_provisional === true && delivery.repairedIgId ? { ig_id_provisional: false } : {}),
        health: {
          state: delivery.needsReconnect ? 'needs_reconnect' : delivery.ok ? 'ok' : 'warn',
          reason: delivery.error ?? undefined,
          checked_at: new Date(now).toISOString(),
          at: new Date(now).toISOString(),
        },
      })
    } catch (err) {
      console.error(`[instagram health] canal ${row.id} falhou:`, err)
    }
  }

  if (result.checked > 0) {
    console.log(
      `[instagram health] ${result.checked} canal(is) — ${result.refreshed} token(s) renovado(s), ${result.repaired} id(s) corrigido(s), ${result.down} precisando reconectar`,
    )
  }
  return result
}
