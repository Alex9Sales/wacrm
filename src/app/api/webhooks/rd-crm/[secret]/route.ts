// ============================================================
// Webhook do RD Station CRM — a VOLTA do espelho (negócio de lá → card daqui).
// O que o time arrasta no RD (No-show, Envio da COF, ganho, perda) chega aqui
// e move o card no FluxiaCRM. Ver lib/integrations/rdcrm/sync.ts.
//
// O RD não assina o webhook: o segredo é a própria URL (48 hex por conta).
// Responde 200 na hora e processa depois — o RD reenvia (até 5x) se passar de
// 5 s ou não for 2xx, e suspende o webhook se errar demais. Reenvio chega
// repetido: o `transaction_uuid` é descartado na 2ª vez.
// ============================================================

import { NextResponse, after } from 'next/server'

import { applyRdWebhook, loadRdIntegrationBySecret } from '@/lib/integrations/rdcrm/sync'
import { claimOnce } from '@/lib/ai/reply-marker'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, context: { params: Promise<{ secret: string }> }) {
  const { secret } = await context.params
  const integ = await loadRdIntegrationBySecret(secret)
  if (!integ) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function POST(request: Request, context: { params: Promise<{ secret: string }> }) {
  const { secret } = await context.params
  const integ = await loadRdIntegrationBySecret(secret)
  if (!integ) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: true })
  }

  after(async () => {
    try {
      const p = (body ?? {}) as { transaction_uuid?: string; event_name?: string; document?: { id?: string; updated_at?: string } }
      const dedupeKey = p.transaction_uuid
        ? `rdcrm:tx:${p.transaction_uuid}`
        : `rdcrm:ev:${p.event_name ?? ''}:${p.document?.id ?? ''}:${p.document?.updated_at ?? ''}`
      // false = já processado (reenvio do RD); undefined = Redis fora → segue
      // (o próprio sync é idempotente: aplicar o mesmo estado 2x não muda nada).
      if ((await claimOnce(dedupeKey, 2 * 86_400)) === false) return
      const r = await applyRdWebhook(integ, body)
      if (r !== 'sem vínculo' && r !== 'ignorado' && r !== 'já estava igual') {
        console.log(`[rd-crm] webhook ${p.event_name ?? '?'} ${p.document?.id ?? ''}: ${r}`)
      }
    } catch (err) {
      console.error('[rd-crm] webhook falhou:', err instanceof Error ? err.message : err)
    }
  })

  return NextResponse.json({ ok: true })
}
