// ============================================================
// Callback do OAuth do LinkedIn (caminho guiado dos Anúncios de Lead).
// O LinkedIn redireciona pra cá com ?code=&state=. Validamos o state (assinado,
// carrega o accountId), trocamos o code por access_token e gravamos/atualizamos
// uma fonte por organização admin (best-effort). Sem escopo de listar orgs,
// grava uma fonte sem organization id p/ o admin completar na mão.
// ============================================================

import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db, leadAdSources } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  exchangeLinkedInCode,
  parseLinkedInState,
  fetchAdministeredOrgs,
} from '@/lib/leads/providers/linkedin-oauth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const APP_URL = process.env.APP_URL || 'https://crm.salestecnologia.com.br'

function back(status: string) {
  return NextResponse.redirect(
    `${APP_URL}/settings?tab=lead-ads&linkedin=${encodeURIComponent(status)}`,
  )
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  if (error) {
    console.warn('[linkedin-oauth/callback] provider error:', error)
    return back('error')
  }
  if (!code) return back('error')

  const parsed = parseLinkedInState(state)
  if (!parsed) {
    console.warn('[linkedin-oauth/callback] invalid/expired state')
    return back('error')
  }

  const token = await exchangeLinkedInCode(code)
  if (!token) return back('error')

  const accountId = parsed.accountId
  const enc = encrypt(token.accessToken)
  // Descobre as orgs admin (best-effort); sem isso, grava 1 fonte sem org id.
  const orgs = await fetchAdministeredOrgs(token.accessToken)
  const targets = orgs.length ? orgs : ['']

  try {
    for (const orgId of targets) {
      const existing = firstOrNull(
        await db
          .select({ id: leadAdSources.id })
          .from(leadAdSources)
          .where(
            and(
              eq(leadAdSources.accountId, accountId),
              eq(leadAdSources.provider, 'linkedin'),
              eq(leadAdSources.externalAccountId, orgId),
            ),
          )
          .limit(1),
      )
      if (existing) {
        await db
          .update(leadAdSources)
          .set({
            accessToken: enc,
            status: 'connected',
            enabled: true,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(leadAdSources.id, existing.id))
      } else {
        await db.insert(leadAdSources).values({
          accountId,
          provider: 'linkedin',
          name: orgId ? `LinkedIn — org ${orgId}` : 'LinkedIn',
          status: 'connected',
          externalAccountId: orgId || null,
          accessToken: enc,
          enabled: true,
          providerMeta: {},
        })
      }
    }
  } catch (err) {
    console.error('[linkedin-oauth/callback] persist error:', err)
    return back('error')
  }

  return back(orgs.length ? 'connected' : 'connected_no_org')
}
