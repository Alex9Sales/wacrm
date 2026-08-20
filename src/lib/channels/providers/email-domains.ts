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

import { promises as dnsp } from 'node:dns'

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

// ---- Detecção do provedor de DNS (pra passo-a-passo específico) ----

export interface DnsProvider {
  /** slug estável — o frontend mapeia p/ o passo-a-passo. */
  id: string
  /** nome amigável do provedor. */
  name: string
  /** link direto pro painel de DNS (quando conhecido). */
  panelUrl: string | null
  /** nameservers detectados (transparência/depuração). */
  nameservers: string[]
}

/** Assinaturas de NS → provedor. Ordem importa (mais específico primeiro). */
const NS_SIGNATURES: Array<{ id: string; name: string; panelUrl: string | null; re: RegExp }> = [
  { id: 'cloudflare', name: 'Cloudflare', panelUrl: 'https://dash.cloudflare.com', re: /\.cloudflare\.com\.?$/i },
  { id: 'registrobr', name: 'Registro.br', panelUrl: 'https://registro.br/painel/', re: /(\.dns\.br|registro\.br)\.?$/i },
  { id: 'hostinger', name: 'Hostinger', panelUrl: 'https://hpanel.hostinger.com/', re: /(hostinger\.com|dns-parking\.com)/i },
  { id: 'godaddy', name: 'GoDaddy', panelUrl: 'https://dcc.godaddy.com/', re: /(domaincontrol\.com|godaddy)\.?$/i },
  { id: 'namecheap', name: 'Namecheap', panelUrl: 'https://ap.www.namecheap.com/', re: /(registrar-servers\.com|namecheap)\.?$/i },
  { id: 'locaweb', name: 'Locaweb', panelUrl: 'https://painel.locaweb.com.br/', re: /locaweb\.com/i },
  { id: 'uolhost', name: 'UOL Host', panelUrl: 'https://painel.uolhost.uol.com.br/', re: /uol(host)?\.com/i },
  { id: 'kinghost', name: 'KingHost', panelUrl: 'https://painel.kinghost.com.br/', re: /kinghost/i },
  { id: 'hostgator', name: 'HostGator', panelUrl: 'https://financeiro.hostgator.com.br/', re: /hostgator/i },
  { id: 'google', name: 'Google / Squarespace', panelUrl: 'https://domains.squarespace.com/', re: /(googledomains\.com|google\.com|squarespace)/i },
  { id: 'vercel', name: 'Vercel', panelUrl: 'https://vercel.com/dashboard/domains', re: /vercel-dns\.com/i },
  { id: 'aws', name: 'AWS Route 53', panelUrl: 'https://console.aws.amazon.com/route53/', re: /awsdns/i },
]

/** Resolve os NS subindo do subdomínio até achar a delegação (ex.:
 *  `fluxia.salestecnologia.com.br` herda os NS de `salestecnologia.com.br`). */
async function resolveNsUp(domain: string): Promise<string[]> {
  const labels = domain.split('.')
  for (let i = 0; i <= labels.length - 2; i++) {
    const d = labels.slice(i).join('.')
    try {
      const ns = await dnsp.resolveNs(d)
      if (ns && ns.length) return ns
    } catch {
      // NODATA/NXDOMAIN nesse nível — tenta o próximo pai.
    }
  }
  return []
}

/** Descobre o provedor de DNS do domínio pelos nameservers. Nunca lança —
 *  em falha volta 'unknown' (o passo-a-passo genérico ainda serve). */
export async function detectDnsProvider(domain: string): Promise<DnsProvider> {
  let nameservers: string[] = []
  try {
    nameservers = await resolveNsUp(domain)
  } catch {
    nameservers = []
  }
  const lower = nameservers.map((n) => n.toLowerCase())
  for (const sig of NS_SIGNATURES) {
    if (lower.some((n) => sig.re.test(n))) {
      return { id: sig.id, name: sig.name, panelUrl: sig.panelUrl, nameservers }
    }
  }
  return { id: 'unknown', name: 'seu provedor de DNS', panelUrl: null, nameservers }
}
