import { eq } from 'drizzle-orm'

import { db, aiCompanyProfile } from '@/db'
import { firstOrNull } from '@/db/helpers'

// ============================================================
// Perfil da empresa ("Núcleo" guiado) — a camada estruturada da Base de
// Conhecimento. Ao contrário dos documentos (retrieval por relevância), o
// perfil é SEMPRE injetado no system prompt: é o "quem somos / o que
// vendemos / horário / pagamento" que o agente precisa saber em toda resposta.
// ============================================================

export interface CompanyProfile {
  business_name: string | null
  description: string | null
  offerings: string | null
  hours: string | null
  payment_methods: string | null
  delivery_info: string | null
  tone: string | null
  notes: string | null
  updated_at: string | null
}

const EMPTY: CompanyProfile = {
  business_name: null,
  description: null,
  offerings: null,
  hours: null,
  payment_methods: null,
  delivery_info: null,
  tone: null,
  notes: null,
  updated_at: null,
}

/** The account's company profile, or an all-null profile when unset. Never
 *  throws — a DB blip on the AI hot path degrades to "no profile". */
export async function getCompanyProfile(
  accountId: string,
): Promise<CompanyProfile> {
  try {
    const row = firstOrNull(
      await db
        .select({
          business_name: aiCompanyProfile.businessName,
          description: aiCompanyProfile.description,
          offerings: aiCompanyProfile.offerings,
          hours: aiCompanyProfile.hours,
          payment_methods: aiCompanyProfile.paymentMethods,
          delivery_info: aiCompanyProfile.deliveryInfo,
          tone: aiCompanyProfile.tone,
          notes: aiCompanyProfile.notes,
          updated_at: aiCompanyProfile.updatedAt,
        })
        .from(aiCompanyProfile)
        .where(eq(aiCompanyProfile.accountId, accountId))
        .limit(1),
    )
    return row ?? EMPTY
  } catch {
    return EMPTY
  }
}

// Rótulos legíveis por campo, na ordem em que entram no prompt.
const FIELD_LABELS: Array<[keyof CompanyProfile, string]> = [
  ['business_name', 'Nome'],
  ['description', 'Sobre'],
  ['offerings', 'Produtos/serviços'],
  ['hours', 'Horário de atendimento'],
  ['payment_methods', 'Formas de pagamento'],
  ['delivery_info', 'Entrega/localização'],
  ['tone', 'Tom de voz'],
  ['notes', 'Observações'],
]

/**
 * Compose the filled profile fields into a readable block for the system
 * prompt (always-on business context). Returns null when nothing is filled,
 * so the caller can skip the section entirely.
 */
export function formatCompanyProfileForPrompt(
  p: CompanyProfile | null,
): string | null {
  if (!p) return null
  const lines: string[] = []
  for (const [key, label] of FIELD_LABELS) {
    const value = (p[key] as string | null)?.trim()
    if (value) lines.push(`${label}: ${value}`)
  }
  return lines.length > 0 ? lines.join('\n') : null
}
