// ============================================================
// 🧾 Administração de cadastro no Asaas DO CLIENTE: apagar, restaurar,
// contar vínculos (16/09).
//
// Existe SÓ para o script de limpeza de órfãos (src/scripts/asaas-orphans.ts).
// O app NÃO importa este arquivo: apagar cliente não é operação de atendimento,
// e o asaasSend de collections.ts continua aceitando só POST/PUT de propósito.
//
// Por que um módulo e não fetch solto no script: a URL sai do mesmo
// asaasBaseUrl (respeita ASAAS_BASE_URL), o timeout é o mesmo (20 s) e a
// mensagem de erro nunca leva header nem chave.
//
// Contagem que falha vira null, NUNCA zero: um 429 no meio da conferência não
// pode liberar um DELETE que leva cobranças junto.
// Sem 'server-only'.
// ============================================================

import { AsaasApiError, asaasBaseUrl, type AsaasCredential, type AsaasCustomer } from './collections'
import { ASAAS_CUSTOMER_ID_RE, type OrphanLinks } from './orphans'

export const ADMIN_TIMEOUT_MS = 20_000
const PAGE_SIZE = 100

type AdminMethod = 'GET' | 'DELETE' | 'POST'

/** Tira a chave de qualquer texto que vá para log (o corpo do Asaas não deveria ecoar, mas não confiamos). */
function scrub(cred: AsaasCredential, text: string): string {
  const key = cred.apiKey ?? ''
  return key.length >= 4 ? text.split(key).join('***') : text
}

/** Primeira descrição de erro do Asaas, curta. Corpo não-JSON vira nada. */
function asaasDescription(body: string): string {
  try {
    const parsed = JSON.parse(body) as { errors?: { description?: string }[] }
    const first = parsed.errors?.[0]?.description
    return first ? `: ${String(first).slice(0, 200)}` : ''
  } catch {
    return ''
  }
}

function customerPath(id: string, suffix = ''): string {
  // Id fora do formato não vira URL: "cus_x/../payments" apagaria outra coisa.
  if (!ASAAS_CUSTOMER_ID_RE.test(id)) throw new AsaasApiError(`id de cliente inválido: ${JSON.stringify(id.slice(0, 40))}`, 0)
  return `/customers/${encodeURIComponent(id)}${suffix}`
}

async function adminCall<T>(cred: AsaasCredential, method: AdminMethod, path: string, query?: Record<string, string | number>): Promise<T> {
  const url = new URL(`${asaasBaseUrl(cred.environment)}${path}`)
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v))

  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: { access_token: cred.apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
    })
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'demorou demais para responder' : 'não respondeu'
    throw new AsaasApiError(scrub(cred, `${method} ${path}: o Asaas ${reason}`), 0)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new AsaasApiError(scrub(cred, `${method} ${path} → HTTP ${res.status}${asaasDescription(body)}`), res.status)
  }
  try {
    return (await res.json()) as T
  } catch {
    throw new AsaasApiError(`${method} ${path}: resposta ilegível (HTTP ${res.status})`, res.status)
  }
}

/** O cadastro como o Asaas devolve, inclusive `deleted` (a remoção lá é lógica). */
export async function getCustomerRaw(cred: AsaasCredential, id: string): Promise<AsaasCustomer & Record<string, unknown>> {
  return adminCall<AsaasCustomer & Record<string, unknown>>(cred, 'GET', customerPath(id))
}

/**
 * DELETE /v3/customers/{id}. ATENÇÃO: pela doc do Asaas isso remove também as
 * assinaturas e as cobranças pendentes/vencidas do cliente, e o restore do
 * cliente não garante que elas voltem. Quem chama confere zero vínculos antes.
 */
export async function deleteCustomer(cred: AsaasCredential, id: string): Promise<{ deleted: boolean; id: string }> {
  const res = await adminCall<{ deleted?: boolean; id?: string }>(cred, 'DELETE', customerPath(id))
  return { deleted: res?.deleted === true, id: res?.id ?? id }
}

/** POST /v3/customers/{id}/restore: desfaz o DELETE (só o cadastro). */
export async function restoreCustomer(cred: AsaasCredential, id: string): Promise<AsaasCustomer & Record<string, unknown>> {
  return adminCall<AsaasCustomer & Record<string, unknown>>(cred, 'POST', customerPath(id, '/restore'))
}

/** Total de uma listagem do Asaas. Resposta sem totalCount nem data vira null (não sabemos). */
export function listTotalOf(res: unknown): number | null {
  if (!res || typeof res !== 'object') return null
  const r = res as { totalCount?: unknown; data?: unknown; hasMore?: unknown }
  const seen = Array.isArray(r.data) ? r.data.length + (r.hasMore === true ? 1 : 0) : null
  const total = typeof r.totalCount === 'number' && Number.isFinite(r.totalCount) && r.totalCount >= 0 ? r.totalCount : null
  if (total === null) return seen
  return seen === null ? total : Math.max(total, seen)
}

async function countOf(cred: AsaasCredential, path: string, customerId: string): Promise<number | null> {
  try {
    return listTotalOf(await adminCall<unknown>(cred, 'GET', path, { customer: customerId, limit: 1 }))
  } catch {
    return null
  }
}

/**
 * Cobranças, assinaturas (qualquer status) e notas fiscais do cliente, AO VIVO.
 * Em série: o Asaas limita requisições e três em paralelo só rendem 429.
 */
export async function countCustomerLinks(cred: AsaasCredential, id: string): Promise<OrphanLinks> {
  if (!ASAAS_CUSTOMER_ID_RE.test(id)) return { payments: null, subscriptions: null, invoices: null }
  const payments = await countOf(cred, '/payments', id)
  const subscriptions = await countOf(cred, '/subscriptions', id)
  const invoices = await countOf(cred, '/invoices', id)
  return { payments, subscriptions, invoices }
}

/**
 * Todos os clientes da conta, com paginação própria. Diferente do
 * listAllCustomers (que para em silêncio no teto), aqui `complete: false`
 * avisa que a lista foi cortada, e quem limpa não pode seguir com lista parcial.
 * Erro de consulta lança (AsaasApiError sem chave).
 */
export async function listCustomersStrict(cred: AsaasCredential, maxPages: number): Promise<{ customers: AsaasCustomer[]; complete: boolean }> {
  const customers: AsaasCustomer[] = []
  for (let page = 0; page < maxPages; page++) {
    const res = await adminCall<{ data?: AsaasCustomer[]; hasMore?: boolean }>(cred, 'GET', '/customers', {
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    })
    const data = res?.data
    // Sem `data` não é "conta vazia": é resposta que não sabemos ler.
    if (!Array.isArray(data)) throw new AsaasApiError(`GET /customers: resposta sem lista (página ${page + 1})`, 0)
    customers.push(...data)
    if (res.hasMore !== true) return { customers, complete: true }
    // hasMore sem dados: resposta estranha, não dá para garantir que acabou.
    if (!data.length) return { customers, complete: false }
  }
  return { customers, complete: false }
}
