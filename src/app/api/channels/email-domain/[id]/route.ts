// ============================================================
// Estado/verificação do domínio próprio de um canal de e-mail.
//   GET  /api/channels/email-domain/:id — status + registros (sem disparar).
//   POST /api/channels/email-domain/:id — DISPARA a verificação no Resend.
// Ambos re-sincronizam o cache (`providerMeta.domainStatus`) e ligam o canal
// ('connected') quando o domínio verifica. Ver email-domains.ts.
// ============================================================

import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db, channels } from '@/db'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  getBrandedDomain,
  verifyBrandedDomain,
  type BrandedDomainState,
} from '@/lib/channels/providers/email-domains'

export const runtime = 'nodejs'

/** Carrega o canal do domínio próprio (escopo da conta) + seus metadados. */
async function loadBrandedChannel(id: string, accountId: string) {
  const [row] = await db
    .select({
      id: channels.id,
      status: channels.status,
      providerMeta: channels.providerMeta,
    })
    .from(channels)
    .where(and(eq(channels.id, id), eq(channels.accountId, accountId)))
    .limit(1)
  if (!row) return null
  const meta = (row.providerMeta ?? {}) as Record<string, unknown>
  const resendDomainId =
    typeof meta.resendDomainId === 'string' ? meta.resendDomainId : null
  return { row, meta, resendDomainId }
}

/** Re-sincroniza o cache + liga o canal quando verificado; monta a resposta. */
async function syncAndRespond(
  id: string,
  accountId: string,
  meta: Record<string, unknown>,
  domain: BrandedDomainState,
) {
  const verified = domain.status === 'verified'
  await db
    .update(channels)
    .set({
      providerMeta: { ...meta, domainStatus: domain.status },
      // Só liga quando verifica; se cair a verificação, volta a desconectado.
      status: verified ? 'connected' : 'disconnected',
    })
    .where(and(eq(channels.id, id), eq(channels.accountId, accountId)))

  return NextResponse.json({
    status: domain.status,
    verified,
    records: domain.records,
    ingestAddress: typeof meta.ingestAddress === 'string' ? meta.ingestAddress : null,
    address: typeof meta.address === 'string' ? meta.address : null,
    domainName: typeof meta.domainName === 'string' ? meta.domainName : null,
  })
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const loaded = await loadBrandedChannel(id, ctx.accountId)
    if (!loaded || !loaded.resendDomainId) {
      return NextResponse.json(
        { error: 'Canal de domínio próprio não encontrado.' },
        { status: 404 },
      )
    }
    const domain = await getBrandedDomain(loaded.resendDomainId)
    return syncAndRespond(id, ctx.accountId, loaded.meta, domain)
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const loaded = await loadBrandedChannel(id, ctx.accountId)
    if (!loaded || !loaded.resendDomainId) {
      return NextResponse.json(
        { error: 'Canal de domínio próprio não encontrado.' },
        { status: 404 },
      )
    }
    const domain = await verifyBrandedDomain(loaded.resendDomainId)
    return syncAndRespond(id, ctx.accountId, loaded.meta, domain)
  } catch (err) {
    return toErrorResponse(err)
  }
}
