'use server'

// ============================================================
// 📒 Importar agenda do celular (Canais → botão "Agenda"). Admin+.
// Prévia = puxa a agenda (WAHA) e SIMULA os dois modos; aplicar = grava.
// Regra de nome em lib/contacts/name-rule.ts; espelho em lib/contacts/phonebook.ts.
// Nunca lança pro cliente (Server Action em prod vira caixa "digest"):
// devolve { ok:false, error } com a mensagem real.
// ============================================================

import { eq } from 'drizzle-orm'

import { db, channels } from '@/db'
import { requireRole } from '@/lib/auth/account'
import { loadChannelByAccount } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import type { NameMode } from '@/lib/contacts/name-rule'
import {
  applyPhonebook,
  phonebookStatus,
  refreshPhonebookFromChannel,
  type PhonebookApplySummary,
} from '@/lib/contacts/phonebook'

export type PhonebookPreview =
  | {
      ok: true
      /** 'pull' = puxamos a agenda agora (WAHA); 'push' = a Meta empurra pelo webhook. */
      kind: 'pull' | 'push'
      entries: number
      syncedAt: string | null
      fill: PhonebookApplySummary
      override: PhonebookApplySummary
    }
  | { ok: false; error: string }

export async function previewPhonebookImport(channelId: string): Promise<PhonebookPreview> {
  try {
    const ctx = await requireRole('admin')
    const ch = await loadChannelByAccount(ctx.accountId, channelId)
    if (!ch) return { ok: false, error: 'Canal não encontrado.' }
    const provider = getProvider(ch.provider)
    let kind: 'pull' | 'push'
    if (provider.listPhonebook) {
      const status = await db
        .select({ status: channels.status })
        .from(channels)
        .where(eq(channels.id, ch.id))
        .limit(1)
      if (status[0]?.status !== 'connected') {
        return { ok: false, error: 'Conecte o número (pareie o QR) antes de importar a agenda.' }
      }
      await refreshPhonebookFromChannel(ch)
      kind = 'pull'
    } else if (ch.provider === 'meta') {
      kind = 'push'
    } else {
      return { ok: false, error: 'Este tipo de canal não tem agenda do celular.' }
    }
    const st = await phonebookStatus(ch.id)
    const base = { accountId: ctx.accountId, channelId: ch.id, createMissing: true, dryRun: true } as const
    const [fill, override] = await Promise.all([
      applyPhonebook({ ...base, mode: 'fill' }),
      applyPhonebook({ ...base, mode: 'override' }),
    ])
    return { ok: true, kind, entries: st.entries, syncedAt: st.syncedAt, fill, override }
  } catch (err) {
    console.error('[phonebook] preview failed:', err)
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Não foi possível ler a agenda do celular.',
    }
  }
}

export async function applyPhonebookImport(
  channelId: string,
  opts: { mode: NameMode; createMissing: boolean },
): Promise<{ ok: true; summary: PhonebookApplySummary } | { ok: false; error: string }> {
  try {
    const ctx = await requireRole('admin')
    const ch = await loadChannelByAccount(ctx.accountId, channelId)
    if (!ch) return { ok: false, error: 'Canal não encontrado.' }
    const mode: NameMode = opts.mode === 'override' ? 'override' : 'fill'
    const summary = await applyPhonebook({
      accountId: ctx.accountId,
      channelId: ch.id,
      mode,
      createMissing: opts.createMissing === true,
      userId: ctx.userId,
    })
    // Marca o opt-in da sincronização periódica (WAHA já carimba ao puxar;
    // Meta carimba aqui pra ficar registrado que a agenda foi aplicada).
    const now = new Date().toISOString()
    await db
      .update(channels)
      .set({ phonebookSyncedAt: now, updatedAt: now })
      .where(eq(channels.id, ch.id))
    return { ok: true, summary }
  } catch (err) {
    console.error('[phonebook] apply failed:', err)
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Não foi possível importar a agenda.',
    }
  }
}
