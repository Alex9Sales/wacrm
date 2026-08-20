// ============================================================
// White-label de e-mail: "Conectar meu domínio".
//
// O cliente quer ENVIAR com a marca dele (`atendimento@empresadele.com`) em vez
// do subdomínio hospedado da Fluxia. Usamos UMA conta Resend (a global) que
// segura VÁRIOS domínios verificados — então o domínio de cada cliente é
// verificado na nossa conta e o `from` do canal aponta pra ele.
//
//   ENVIAR:  o cliente adiciona SPF + DKIM no DNS do domínio dele → o Resend
//            verifica → passamos a mandar com a marca dele.
//   RECEBER: o cliente ENCAMINHA a caixa dele (`atendimento@empresadele.com`)
//            pro alias hospedado (`ingestAddress`) — aí cai no Cloudflare →
//            Worker → webhook, como qualquer canal hospedado. (Padrão dos
//            helpdesks: forward + verificação de domínio p/ envio.)
//
// Este módulo só fala com a API de domínios do Resend (chave global).
// ============================================================

import { Resend } from 'resend'

/** Subdomínio hospedado da Fluxia (recebe pelo Cloudflare catch-all → Worker).
 *  Usado tanto no modo hospedado (`apelido@…`) quanto como alvo de
 *  encaminhamento (`ingestAddress`) no modo domínio-próprio. */
export const EMAIL_HOSTED_DOMAIN =
  process.env.EMAIL_HOSTED_DOMAIN || 'atendimento.salestecnologia.com.br'

/** Registro DNS normalizado pra UI (o que o cliente precisa colar no DNS). */
export interface BrandedDomainRecord {
  record: string // 'SPF' | 'DKIM'
  type: string // 'TXT' | 'MX' | 'CNAME'
  name: string
  value: string
  ttl: string
  priority?: number
  status: string // pending | verified | ...
}

export interface BrandedDomainState {
  id: string
  name: string
  status: string // pending | verified | partially_verified | failed | not_started
  records: BrandedDomainRecord[]
}

function resendForDomains(): Resend {
  const key = process.env.RESEND_API_KEY
  if (!key) {
    throw new Error('RESEND_API_KEY não configurada — necessária p/ domínios.')
  }
  return new Resend(key)
}

/** Só os registros que o cliente precisa adicionar p/ ENVIAR (SPF + DKIM). O
 *  Resend também pode devolver "Receiving"/"Tracking" — não usamos (inbound é
 *  por encaminhamento; tracking é opcional). */
function toSendingRecords(records: unknown): BrandedDomainRecord[] {
  if (!Array.isArray(records)) return []
  return records
    .filter(
      (r) =>
        r && (r.record === 'SPF' || r.record === 'DKIM'),
    )
    .map((r) => ({
      record: String(r.record),
      type: String(r.type),
      name: String(r.name ?? ''),
      value: String(r.value ?? ''),
      ttl: String(r.ttl ?? 'Auto'),
      priority: typeof r.priority === 'number' ? r.priority : undefined,
      status: String(r.status ?? 'pending'),
    }))
}

/** Cria o domínio na nossa conta Resend (envio). Retorna id + registros DNS. */
export async function createBrandedDomain(
  domain: string,
): Promise<BrandedDomainState> {
  const resend = resendForDomains()
  const { data, error } = await resend.domains.create({ name: domain })
  if (error || !data) {
    throw new Error(`Resend não criou o domínio: ${error?.message ?? 'sem dados'}`)
  }
  return {
    id: data.id,
    name: data.name,
    status: data.status,
    records: toSendingRecords(data.records),
  }
}

/** Estado atual do domínio (status + registros) — pra UI e p/ liberar o envio. */
export async function getBrandedDomain(id: string): Promise<BrandedDomainState> {
  const resend = resendForDomains()
  const { data, error } = await resend.domains.get(id)
  if (error || !data) {
    throw new Error(`Resend não retornou o domínio: ${error?.message ?? 'sem dados'}`)
  }
  return {
    id: data.id,
    name: data.name,
    status: data.status,
    records: toSendingRecords(data.records),
  }
}

/** Dispara a verificação no Resend e devolve o estado logo em seguida. */
export async function verifyBrandedDomain(id: string): Promise<BrandedDomainState> {
  const resend = resendForDomains()
  const { error } = await resend.domains.verify(id)
  if (error) {
    throw new Error(`Resend não verificou o domínio: ${error.message}`)
  }
  return getBrandedDomain(id)
}

/** O `name` do e-mail (antes do @) → o domínio (depois do @), minúsculo. */
export function domainOfEmail(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at < 0) return null
  const domain = email.slice(at + 1).trim().toLowerCase()
  return domain.includes('.') ? domain : null
}
