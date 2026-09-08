// ============================================================
// Alvo do envio: qual identificador do contato vai pro provider, dado o CANAL.
//
// 08/09 (unificação dos contatos do Alex): o contato ficou com telefone E
// `external_id` = e-mail (identidade do canal de e-mail). O envio escolhia o
// external_id sempre que existia — e o WhatsApp oficial recebeu um e-mail
// como destinatário: "(#131009) Parameter value is not valid", comando do
// dono mudo. O mesmo acontece sem unificação: o canal de e-mail grava o
// endereço no external_id de qualquer contato cujo e-mail bata (inbound.ts),
// inclusive contato de WhatsApp com telefone.
//
// Regra: o CANAL decide. WhatsApp → telefone (external_id só sem telefone e
// se parecer id de WhatsApp). E-mail → e-mail. Instagram/Messenger → external_id.
// Puro — testável.
// ============================================================

export const WHATSAPP_TARGET_PROVIDERS = ['meta', 'waha', 'evolution', 'evogo'] as const
export const EMAIL_TARGET_PROVIDERS = ['email', 'gmail'] as const

export type TargetKind = 'phone' | 'group' | 'external' | 'email'

export interface PickTargetInput {
  provider: string
  /** Telefone já sanitizado (só dígitos) ou ''. */
  phoneDigits: string
  externalId: string | null | undefined
  email: string | null | undefined
  isGroup?: boolean
}

const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
/** Id de WhatsApp: dígitos puros ou jid (…@c.us, …@lid, …@s.whatsapp.net, …@g.us). */
const looksLikeWhatsAppId = (s: string) => /^\d{8,20}$/.test(s) || /^[\d-]+@(c\.us|lid|s\.whatsapp\.net|g\.us)$/.test(s)

export function pickProviderTarget(input: PickTargetInput): { target: string; kind: TargetKind } | null {
  const provider = (input.provider ?? '').toLowerCase()
  const ext = (input.externalId ?? '').trim()
  const email = (input.email ?? '').trim()
  const phone = (input.phoneDigits ?? '').trim()

  if ((EMAIL_TARGET_PROVIDERS as readonly string[]).includes(provider)) {
    if (email && looksLikeEmail(email)) return { target: email, kind: 'email' }
    if (ext && looksLikeEmail(ext)) return { target: ext, kind: 'email' }
    return null
  }

  if ((WHATSAPP_TARGET_PROVIDERS as readonly string[]).includes(provider)) {
    if (input.isGroup && phone) return { target: phone, kind: 'group' }
    if (phone) return { target: phone, kind: 'phone' }
    if (ext && looksLikeWhatsAppId(ext)) return { target: ext, kind: 'external' }
    return null
  }

  // Instagram, Messenger e afins: a identidade é o external_id (IGSID/PSID).
  if (ext) return { target: ext, kind: 'external' }
  if (phone) return { target: phone, kind: 'phone' }
  return null
}
