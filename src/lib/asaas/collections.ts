// ============================================================
// 🧾 Cliente da API do Asaas DO CLIENTE (agente de cobrança, Fase 1).
//
// NÃO confundir com lib/billing/asaas.ts — aquele é a nossa assinatura Fluxia,
// com chave única de ambiente. Aqui a chave vem por conexão (o cliente tem
// duas contas), então TODA função recebe a credencial como argumento.
//
// Fase 1 é SOMENTE LEITURA: nada aqui cria, altera ou cancela cobrança.
// Sem 'server-only' — o worker precisa alcançar isso na Fase 2.
// ============================================================

export type AsaasEnv = 'sandbox' | 'production'

/** Status de cobrança do Asaas que aparecem numa carteira. */
export const ASAAS_STATUSES = [
  'OVERDUE',
  'PENDING',
  'CONFIRMED',
  'RECEIVED',
  'RECEIVED_IN_CASH',
  'REFUNDED',
  'CHARGEBACK_REQUESTED',
  'AWAITING_RISK_ANALYSIS',
] as const

/**
 * O que conta como "vencido" enquanto o cliente não define o dele (Fase 0).
 * Deliberadamente conservador: só o que o Asaas já marcou como vencido.
 */
export const DEFAULT_OVERDUE_STATUSES = ['OVERDUE'] as const

export interface AsaasCredential {
  apiKey: string
  environment: AsaasEnv
}

export class AsaasApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'AsaasApiError'
  }
}

function baseUrl(env: AsaasEnv): string {
  const override = env === 'sandbox' ? process.env.ASAAS_SANDBOX_BASE_URL : process.env.ASAAS_BASE_URL
  if (override) return override.replace(/\/+$/, '')
  return env === 'sandbox' ? 'https://api-sandbox.asaas.com/v3' : 'https://api.asaas.com/v3'
}

/**
 * Traduz o erro do Asaas para algo que o cliente entenda na tela. A chave
 * NUNCA entra na mensagem — nem em pedaço, nem mascarada.
 */
function humanError(status: number, body: string): string {
  if (status === 401) return 'Chave recusada pelo Asaas. Confira se ela é do ambiente escolhido (sandbox × produção).'
  if (status === 403) return 'A chave não tem permissão para ler cobranças nesta conta do Asaas.'
  if (status === 429) return 'O Asaas pediu para diminuir o ritmo (limite de requisições). Tente de novo em alguns minutos.'
  if (status >= 500) return 'O Asaas está indisponível no momento. Nada foi alterado; tente de novo mais tarde.'
  try {
    const parsed = JSON.parse(body) as { errors?: { description?: string }[] }
    const first = parsed.errors?.[0]?.description
    if (first) return first
  } catch {
    /* corpo não-JSON: cai no genérico abaixo */
  }
  return `O Asaas recusou a consulta (HTTP ${status}).`
}

async function asaasGet<T>(cred: AsaasCredential, path: string, query?: Record<string, string | number>): Promise<T> {
  const url = new URL(`${baseUrl(cred.environment)}${path}`)
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v))

  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { access_token: cred.apiKey, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'demorou demais para responder' : 'não respondeu'
    throw new AsaasApiError(`O Asaas ${reason}. Nada foi alterado.`, 0)
  }

  if (!res.ok) throw new AsaasApiError(humanError(res.status, await res.text().catch(() => '')), res.status)
  return (await res.json()) as T
}

// ---------------------------------------------------------------- cobranças

export interface AsaasPayment {
  id: string
  customer: string
  value: number
  netValue?: number
  dueDate: string
  status: string
  billingType?: string
  description?: string | null
  invoiceUrl?: string | null
  bankSlipUrl?: string | null
  installmentNumber?: number | null
}

interface AsaasList<T> {
  data: T[]
  hasMore: boolean
  totalCount?: number
}

/** Teto de páginas: uma carteira normal tem dezenas, não milhares. */
const MAX_PAGES = 50
const PAGE_SIZE = 100

/**
 * Lista as cobranças nos status pedidos. Paginado até acabar (ou até o teto,
 * que existe para uma conta gigante não travar a sincronização).
 */
export async function listCharges(
  cred: AsaasCredential,
  statuses: readonly string[] = DEFAULT_OVERDUE_STATUSES,
): Promise<AsaasPayment[]> {
  const out: AsaasPayment[] = []
  for (const status of statuses) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await asaasGet<AsaasList<AsaasPayment>>(cred, '/payments', {
        status,
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
      })
      out.push(...(res.data ?? []))
      if (!res.hasMore || !res.data?.length) break
    }
  }
  return out
}

// ---------------------------------------------------------------- devedores

export interface AsaasCustomer {
  id: string
  name?: string | null
  cpfCnpj?: string | null
  email?: string | null
  phone?: string | null
  mobilePhone?: string | null
  /** true = o Asaas NÃO manda avisos (e-mail/SMS/WhatsApp) para este cliente. */
  notificationDisabled?: boolean
  externalReference?: string | null
}

/**
 * Busca os devedores das cobranças. O /payments só devolve o ID do cliente,
 * então precisamos de uma volta por devedor — com cache dentro da rodada, que
 * é o que faz 40 cobranças virarem ~25 chamadas em vez de 40.
 */
export async function fetchCustomers(cred: AsaasCredential, ids: string[]): Promise<Map<string, AsaasCustomer>> {
  const unique = [...new Set(ids.filter(Boolean))]
  const map = new Map<string, AsaasCustomer>()

  // Em série de propósito: o Asaas limita requisições por minuto e uma carteira
  // típica tem dezenas de devedores. Correr aqui só rende HTTP 429.
  for (const id of unique) {
    try {
      map.set(id, await asaasGet<AsaasCustomer>(cred, `/customers/${encodeURIComponent(id)}`))
    } catch (err) {
      // Devedor que não abre não derruba a sincronização inteira: a cobrança
      // entra na carteira com os dados que já temos e vira pendência de
      // casamento na tela.
      if (err instanceof AsaasApiError && err.status === 429) throw err
    }
  }
  return map
}

/** Confere a chave antes de salvar: uma leitura barata que prova o acesso. */
export async function testCredential(cred: AsaasCredential): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await asaasGet<AsaasList<AsaasPayment>>(cred, '/payments', { limit: 1 })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof AsaasApiError ? err.message : 'Não foi possível falar com o Asaas.' }
  }
}

// ================================================================ ESCRITA
// Até aqui este módulo era SOMENTE LEITURA. A partir do `criar_cobranca`
// (05/09) a IA também CRIA cobrança no Asaas do cliente, no meio do
// atendimento. Tudo que escreve fica abaixo desta linha, de propósito.

async function asaasSend<T>(cred: AsaasCredential, method: 'POST' | 'PUT', path: string, body: Record<string, unknown>): Promise<T> {
  const url = `${baseUrl(cred.environment)}${path}`
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: { access_token: cred.apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'demorou demais para responder' : 'não respondeu'
    throw new AsaasApiError(`O Asaas ${reason}. Nada foi criado.`, 0)
  }
  if (!res.ok) throw new AsaasApiError(humanError(res.status, await res.text().catch(() => '')), res.status)
  return (await res.json()) as T
}

const asaasPost = <T>(cred: AsaasCredential, path: string, body: Record<string, unknown>) => asaasSend<T>(cred, 'POST', path, body)

export interface AsaasCustomerInput {
  name: string
  /** Só dígitos, com DDI (5567…). */
  mobilePhone: string
  cpfCnpj?: string | null
  email?: string | null
  /** Nosso id do contato — é por ele que reencontramos o cliente da próxima vez. */
  externalReference: string
}

/**
 * Reencontra o cliente no Asaas pelo NOSSO id de contato (externalReference,
 * gravado quando fomos nós que criamos) ou pelo CPF/CNPJ; senão cria.
 *
 * Limitação honesta: cliente que já existia no Asaas SEM esses dois dados não
 * é reencontrado — vira um segundo cadastro lá. O Asaas tolera duplicidade de
 * cliente; a cobrança sai certa do mesmo jeito.
 */
export async function findOrCreateCustomer(cred: AsaasCredential, input: AsaasCustomerInput): Promise<AsaasCustomer> {
  const byRef = await asaasGet<AsaasList<AsaasCustomer>>(cred, '/customers', { externalReference: input.externalReference, limit: 1 })
  if (byRef.data?.[0]) return byRef.data[0]

  const doc = (input.cpfCnpj ?? '').replace(/\D/g, '')
  if (doc.length === 11 || doc.length === 14) {
    const byDoc = await asaasGet<AsaasList<AsaasCustomer>>(cred, '/customers', { cpfCnpj: doc, limit: 1 })
    if (byDoc.data?.[0]) return byDoc.data[0]
  }

  return asaasPost<AsaasCustomer>(cred, '/customers', {
    name: input.name,
    mobilePhone: input.mobilePhone,
    ...(doc ? { cpfCnpj: doc } : {}),
    ...(input.email ? { email: input.email } : {}),
    externalReference: input.externalReference,
    notificationDisabled: true, // quem fala com o cliente é o CRM, não o Asaas
  })
}

export type AsaasBillingType = 'UNDEFINED' | 'PIX' | 'BOLETO' | 'CREDIT_CARD'

export interface CreatePaymentInput {
  customer: string
  value: number
  /** YYYY-MM-DD */
  dueDate: string
  description: string
  billingType: AsaasBillingType
  /** Nosso rastro (conversa) — aparece no Asaas e volta no webhook. */
  externalReference: string
}

/** Cria a cobrança. Devolve o que o Asaas devolveu — inclusive `invoiceUrl`. */
export async function createPayment(cred: AsaasCredential, input: CreatePaymentInput): Promise<AsaasPayment> {
  return asaasPost<AsaasPayment>(cred, '/payments', {
    customer: input.customer,
    billingType: input.billingType,
    value: Number(input.value.toFixed(2)),
    dueDate: input.dueDate,
    description: input.description.slice(0, 500),
    externalReference: input.externalReference,
  })
}

// ============================================================ ITEM 5 (05/09)

/**
 * Liga/desliga TODOS os avisos do Asaas para um cliente (e-mail, SMS, WhatsApp
 * deles). O cliente da Fluxia paga por envio no Asaas e quer que o CRM avise —
 * então o Asaas cala e a régua fala.
 */
export async function setCustomerNotifications(cred: AsaasCredential, customerId: string, disabled: boolean): Promise<void> {
  await asaasSend<AsaasCustomer>(cred, 'PUT', `/customers/${encodeURIComponent(customerId)}`, { notificationDisabled: disabled })
}

/**
 * Todos os clientes da conta (paginado, teto de páginas para conta gigante
 * não travar). É a base do detector de duplicados e do desligar em massa.
 */
export async function listAllCustomers(cred: AsaasCredential, maxPages = MAX_PAGES): Promise<AsaasCustomer[]> {
  const out: AsaasCustomer[] = []
  for (let page = 0; page < maxPages; page++) {
    const res = await asaasGet<AsaasList<AsaasCustomer>>(cred, '/customers', { offset: page * PAGE_SIZE, limit: PAGE_SIZE })
    out.push(...(res.data ?? []))
    if (!res.hasMore || !res.data?.length) break
  }
  return out
}
