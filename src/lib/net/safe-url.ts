// ============================================================
// 🛡️ Anti-SSRF — URLs que o SERVIDOR busca a pedido de um tenant (ferramentas
// externas do agente, import de documento por URL, bases de lead-ads).
//
// Auditoria 02/09: a ferramenta externa buscava qualquer URL; da rede do
// worker dava pra listar o bucket do MinIO e baixar arquivo de outra conta
// pelo proxy público. Regra: só http(s) público, só portas 80/443, nunca IP
// privado/loopback/link-local, nunca nome interno (sem ponto), e o DNS do host
// também não pode apontar pra rede interna.
//
// Puro + Node `dns` (worker-reachable; sem 'server-only').
// ============================================================

import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'

export interface UrlVerdict {
  ok: boolean
  reason?: string
}

/** Portas extras permitidas (ex.: ERP em :8443) — lista no env, separada por vírgula. */
function extraPorts(): Set<number> {
  const raw = process.env.OUTBOUND_ALLOWED_PORTS || ''
  return new Set(
    raw
      .split(',')
      .map((p) => Number(p.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n < 65536),
  )
}

/** IPv4 privado/reservado? (RFC1918, loopback, link-local, CGNAT, multicast…) */
export function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0) return true // 192.0.0.0/24 + 192.0.2.0/24 (doc)
  if (a === 198 && (b === 18 || b === 19)) return true // benchmark
  if (a >= 224) return true // multicast / reservado / broadcast
  return false
}

/** IPv6 privado/reservado? (loopback, ULA, link-local, mapeado v4, unspecified) */
export function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (s === '::' || s === '::1') return true
  if (s.startsWith('fc') || s.startsWith('fd')) return true // ULA fc00::/7
  if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true // link-local
  if (s.startsWith('::ffff:')) {
    const v4 = s.slice(7)
    return isIP(v4) === 4 ? isPrivateIPv4(v4) : true
  }
  if (s.startsWith('2001:db8')) return true // documentação
  return false
}

export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, ''))
  if (kind === 4) return isPrivateIPv4(ip)
  if (kind === 6) return isPrivateIPv6(ip)
  return true // não é IP → trata como bloqueado neste caminho
}

/** Hosts NUNCA permitidos como destino (o próprio S3/MinIO, mesmo que público). */
function blockedHosts(): Set<string> {
  const out = new Set<string>(['localhost', 'localhost.localdomain', 'metadata.google.internal'])
  for (const v of [process.env.S3_ENDPOINT, process.env.WAHA_BASE_URL, process.env.REDIS_URL, process.env.DATABASE_URL]) {
    if (!v) continue
    try {
      out.add(new URL(v).hostname.toLowerCase())
    } catch {
      /* ignore */
    }
  }
  return out
}

/**
 * Checagem PURA (sem rede): protocolo, porta, forma do host e IPs literais.
 * Use ao SALVAR a configuração (feedback imediato) e antes do DNS.
 */
export function classifyUrl(input: string | URL): UrlVerdict {
  let url: URL
  try {
    url = typeof input === 'string' ? new URL(input) : input
  } catch {
    return { ok: false, reason: 'URL inválida.' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Só http(s) é permitido.' }
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URL com usuário:senha não é permitida.' }
  }
  const host = url.hostname.toLowerCase()
  if (!host) return { ok: false, reason: 'URL sem host.' }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (port !== 80 && port !== 443 && !extraPorts().has(port)) {
    return { ok: false, reason: `Porta ${port} não permitida (só 80/443).` }
  }
  if (blockedHosts().has(host)) return { ok: false, reason: 'Destino interno não permitido.' }
  const bare = host.replace(/^\[|\]$/g, '')
  if (isIP(bare)) {
    if (isPrivateIp(bare)) return { ok: false, reason: 'IP de rede interna não permitido.' }
    return { ok: true }
  }
  // Nome sem ponto = serviço interno (docker/rede local) ou .localhost/.internal.
  if (!host.includes('.') || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.arpa')) {
    return { ok: false, reason: 'Host interno não permitido.' }
  }
  return { ok: true }
}

/**
 * Checagem COMPLETA (com DNS): além do classifyUrl, resolve o host e recusa se
 * QUALQUER endereço apontar pra rede interna. Lança Error com mensagem clara.
 */
export async function assertPublicUrl(input: string | URL): Promise<URL> {
  const url = typeof input === 'string' ? new URL(input) : input
  const shape = classifyUrl(url)
  if (!shape.ok) throw new Error(`URL bloqueada: ${shape.reason}`)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return url
  let addrs: { address: string }[]
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true })
  } catch {
    throw new Error('URL bloqueada: host não resolve.')
  }
  if (addrs.length === 0) throw new Error('URL bloqueada: host não resolve.')
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('URL bloqueada: o host aponta pra rede interna.')
  }
  return url
}

/**
 * Base de API configurável por tenant (lead-ads): só aceita a sobrescrita se o
 * host for o oficial (ou subdomínio dele); senão volta pro padrão.
 */
export function restrictBase(candidate: unknown, fallback: string, allowedHosts: string[]): string {
  if (typeof candidate !== 'string' || !candidate) return fallback
  try {
    const u = new URL(candidate)
    if (u.protocol !== 'https:') return fallback
    const h = u.hostname.toLowerCase()
    if (allowedHosts.some((a) => h === a || h.endsWith(`.${a}`))) return candidate.replace(/\/+$/, '')
  } catch {
    /* inválida */
  }
  return fallback
}
