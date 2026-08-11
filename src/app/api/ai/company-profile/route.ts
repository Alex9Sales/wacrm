import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db, aiCompanyProfile } from '@/db'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { getCompanyProfile } from '@/lib/ai/company-profile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ============================================================
// Perfil da empresa ("Núcleo" guiado) — a camada estruturada da Base de
// Conhecimento. GET (any member) devolve o perfil da conta; PUT (admin+)
// faz upsert. Uma linha por conta (unique account_id).
// ============================================================

/** Campos de texto do perfil, na ordem do formulário. */
const FIELDS = [
  'business_name',
  'description',
  'offerings',
  'hours',
  'payment_methods',
  'delivery_info',
  'tone',
  'notes',
] as const

const MAX_LEN = 5000

/** Trim + cap a text field; empty → null. */
function clean(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  return t.length > MAX_LEN ? t.slice(0, MAX_LEN) : t
}

export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    const profile = await getCompanyProfile(accountId)
    return NextResponse.json({ profile })
  } catch {
    return NextResponse.json({ error: 'Falha ao carregar o perfil.' }, { status: 400 })
  }
}

export async function PUT(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const values: Record<string, string | null> = {}
    for (const f of FIELDS) values[f] = clean(body[f])

    const now = new Date().toISOString()
    await db
      .insert(aiCompanyProfile)
      .values({
        accountId,
        businessName: values.business_name,
        description: values.description,
        offerings: values.offerings,
        hours: values.hours,
        paymentMethods: values.payment_methods,
        deliveryInfo: values.delivery_info,
        tone: values.tone,
        notes: values.notes,
        updatedBy: userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: aiCompanyProfile.accountId,
        set: {
          businessName: values.business_name,
          description: values.description,
          offerings: values.offerings,
          hours: values.hours,
          paymentMethods: values.payment_methods,
          deliveryInfo: values.delivery_info,
          tone: values.tone,
          notes: values.notes,
          updatedBy: userId,
          updatedAt: now,
        },
      })

    const profile = await getCompanyProfile(accountId)
    return NextResponse.json({ profile })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Falha ao salvar o perfil.'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
