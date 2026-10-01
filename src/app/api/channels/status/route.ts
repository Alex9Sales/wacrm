// ============================================================
// GET /api/channels/status — lightweight channel-health list for the
// global "channel down — reconnect" banner.
//
// Unlike GET /api/channels (admin-gated, returns provider_meta), this is
// readable by ANY account member so agents also see the heads-up when a
// session drops — they just can't re-pair (that stays admin-only). Returns
// only the non-sensitive fields the banner needs; never credentials,
// webhook_secret, or provider_meta.
//
// Stale-status guard: the stored `channels.status` can drift from the
// gateway's real state (a session recovers on its own, or a lifecycle
// webhook for the final WORKING transition never arrives), which would
// leave the banner alarming on a channel that's actually fine. So for any
// channel that LOOKS down, we confirm live via getState and persist the
// fresh value before answering. Connected channels (the common case) skip
// the extra call entirely — the reconcile only runs on the rare down one.
//
// 01/10: canais de TOKEN (Instagram, Messenger, WhatsApp oficial) também
// trazem `problem` — antes o banner só via QR e Gmail, e um Instagram com o
// token invalidado pela Meta (erro 190) ficou fora do ar sem aviso nenhum. O
// motivo vai traduzido numa de três frases fixas (lib/channels/channel-down):
// nunca o texto cru da Meta, que pode trazer fbtrace_id e ids de conta.
// ============================================================

import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db, channels } from '@/db'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import {
  loadChannelByAccount,
  updateChannelStatus,
} from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import type { ProviderId } from '@/lib/channels/provider'
import { gmailHealthOf, gmailProblem } from '@/lib/channels/gmail-health-state'
import { tokenChannelProblem } from '@/lib/channels/channel-down'

/** Frase curta pro banner (lido por todos — sem "troque aqui"). */
function gmailBannerProblem(providerMeta: unknown): string | null {
  const p = gmailProblem(gmailHealthOf(providerMeta))
  if (!p) return null
  if (p.kind === 'auth_failed') return 'o Google recusou a senha de app'
  return p.source === 'imap' ? 'não estamos conseguindo ler a caixa' : 'os envios estão falhando'
}

export async function GET(req?: Request) {
  try {
    const ctx = await getCurrentAccount()
    // ?reconcile=0 = releitura automática do banner (a cada 5 min / ao voltar
    // pra aba): só LÊ. A conciliação com o gateway grava 'connected' por cima
    // do 'error' que o channel-halt da cobrança põe por reputação (463) — feita
    // a cada 5 min, desfazia a trava sistematicamente (revisão de 01/10).
    const reconcile = req ? new URL(req.url).searchParams.get('reconcile') !== '0' : true
    const rows = await db
      .select({
        id: channels.id,
        provider: channels.provider,
        name: channels.name,
        status: channels.status,
        phoneNumber: channels.phoneNumber,
        providerMeta: channels.providerMeta,
      })
      .from(channels)
      .where(eq(channels.accountId, ctx.accountId))

    // Reconcile only the channels that look down — confirm with the gateway
    // so a stale DB status never raises a false "channel down" banner.
    const out = await Promise.all(
      rows.map(async (ch) => {
        if (ch.status === 'connected' || !reconcile) return ch
        try {
          const provider = getProvider(ch.provider as ProviderId)
          if (!provider.getState) return ch
          const full = await loadChannelByAccount(ctx.accountId, ch.id)
          if (!full) return ch
          const { status, phoneNumber } = await provider.getState(full)
          if (status !== ch.status) {
            await updateChannelStatus(ch.id, status, phoneNumber ?? undefined)
          }
          return { ...ch, status }
        } catch {
          // Gateway unreachable — fall back to the stored status.
          return ch
        }
      }),
    )

    return NextResponse.json({
      channels: out.map((ch) => ({
        id: ch.id,
        provider: ch.provider,
        name: ch.name,
        status: ch.status,
        phone_number: ch.phoneNumber,
        // 📧 Gmail fica 'connected' mesmo com a senha recusada (o poll segue
        // tentando): o problema real vem da saúde. Só a frase — nunca o
        // provider_meta.
        // 🔑 Canal de token (IG/Messenger/WhatsApp oficial): problema quando
        // o status caiu OU o monitor marcou needs_reconnect; demais → null.
        problem:
          ch.provider === 'gmail'
            ? gmailBannerProblem(ch.providerMeta)
            : tokenChannelProblem({
                provider: ch.provider,
                status: ch.status,
                providerMeta: ch.providerMeta,
              }),
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
