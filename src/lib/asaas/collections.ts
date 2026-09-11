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
  /** Juros + multa calculados pelo Asaas para pagamento após o vencimento (0/ausente antes de vencer). */
  interestValue?: number | null
  dueDate: string
  status: string
  billingType?: string
  description?: string | null
  invoiceUrl?: string | null
  bankSlipUrl?: string | null
  installmentNumber?: number | null
  /** Assinatura de origem, quando a cobrança nasceu de uma recorrência. */
  subscription?: string | null
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

/**
 * Endereço do cliente no Asaas. Existe por causa da NOTA FISCAL (11/09,
 * João/GoLink): sem endereço completo o Asaas não emite. Cidade e estado o
 * próprio Asaas resolve pelo CEP, então não pedimos.
 */
export interface AsaasCustomerAddress {
  /** CEP, só dígitos. */
  postalCode?: string | null
  /** Logradouro, sem o número. */
  address?: string | null
  addressNumber?: string | null
  complement?: string | null
  /** Bairro. */
  province?: string | null
}

export interface AsaasCustomerInput {
  name: string
  /** Só dígitos, com DDI (5567…). */
  mobilePhone: string
  cpfCnpj?: string | null
  email?: string | null
  /** Nosso id do contato — é por ele que reencontramos o cliente da próxima vez. */
  externalReference: string
  address?: AsaasCustomerAddress | null
}

/** Só os campos de endereço realmente preenchidos — o Asaas rejeita string vazia. */
function addressFields(a: AsaasCustomerAddress | null | undefined): Record<string, string> {
  if (!a) return {}
  const out: Record<string, string> = {}
  const put = (k: string, v: string | null | undefined) => {
    const t = (v ?? '').trim()
    if (t) out[k] = k === 'postalCode' ? t.replace(/\D/g, '') : t
  }
  put('postalCode', a.postalCode)
  put('address', a.address)
  put('addressNumber', a.addressNumber)
  put('complement', a.complement)
  put('province', a.province)
  return out
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
  const doc = (input.cpfCnpj ?? '').replace(/\D/g, '')
  const endereco = addressFields(input.address)
  const email = (input.email ?? '').trim()
  const byRef = await asaasGet<AsaasList<AsaasCustomer>>(cred, '/customers', { externalReference: input.externalReference, limit: 1 })
  const existente = byRef.data?.[0] ?? (doc.length === 11 || doc.length === 14
    ? (await asaasGet<AsaasList<AsaasCustomer>>(cred, '/customers', { cpfCnpj: doc, limit: 1 })).data?.[0]
    : undefined)

  if (existente) {
    // 08/09: o Asaas de produção exige CPF/CNPJ pra gerar cobrança.
    // 11/09: e e-mail + endereço pra emitir nota fiscal. Cliente que já existe
    // recebe agora o que veio preenchido — sem apagar o que já estava lá.
    const patch: Record<string, string> = { ...endereco }
    if (!existente.cpfCnpj && (doc.length === 11 || doc.length === 14)) patch.cpfCnpj = doc
    if (email && !existente.email) patch.email = email
    if (Object.keys(patch).length === 0) return existente
    return asaasSend<AsaasCustomer>(cred, 'PUT', `/customers/${encodeURIComponent(existente.id)}`, {
      ...patch,
      notificationDisabled: true,
    })
  }

  return asaasPost<AsaasCustomer>(cred, '/customers', {
    name: input.name,
    mobilePhone: input.mobilePhone,
    ...(doc ? { cpfCnpj: doc } : {}),
    ...(email ? { email } : {}),
    ...endereco,
    externalReference: input.externalReference,
    notificationDisabled: true, // quem fala com o cliente é o CRM, não o Asaas
  })
}

/** Grava o CPF/CNPJ num cliente que existia sem documento (e mantém os avisos do Asaas desligados). */
export async function updateCustomerDocument(cred: AsaasCredential, customerId: string, cpfCnpj: string): Promise<AsaasCustomer> {
  return asaasSend<AsaasCustomer>(cred, 'PUT', `/customers/${encodeURIComponent(customerId)}`, {
    cpfCnpj: cpfCnpj.replace(/\D/g, ''),
    notificationDisabled: true,
  })
}

export type AsaasBillingType = 'UNDEFINED' | 'PIX' | 'BOLETO' | 'CREDIT_CARD'

export interface CreatePaymentInput {
  customer: string
  /** Valor TOTAL. Com `installments` ≥ 2 vira `totalValue` dividido em N parcelas. */
  value: number
  /** YYYY-MM-DD (da 1ª parcela, quando parcelado) */
  dueDate: string
  description: string
  billingType: AsaasBillingType
  /** Nosso rastro (conversa) — aparece no Asaas e volta no webhook. */
  externalReference: string
  /** Parcelas (2–60) — 08/09, pedido do Rafael/Alex ("em 3x"). */
  installments?: number | null
}

/** Cria a cobrança (à vista ou parcelada). Devolve o que o Asaas devolveu — inclusive `invoiceUrl`
 *  (no parcelado, é a 1ª parcela; as demais entram na carteira pela sincronização). */
export async function createPayment(cred: AsaasCredential, input: CreatePaymentInput): Promise<AsaasPayment> {
  const total = Number(input.value.toFixed(2))
  const n = input.installments && input.installments >= 2 ? Math.min(60, Math.trunc(input.installments)) : null
  return asaasPost<AsaasPayment>(cred, '/payments', {
    customer: input.customer,
    billingType: input.billingType,
    ...(n ? { installmentCount: n, totalValue: total } : { value: total }),
    dueDate: input.dueDate,
    description: input.description.slice(0, 500),
    externalReference: input.externalReference,
  })
}

// ---------------------------------------------------------------- assinatura

export type AsaasCycle = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'BIMONTHLY' | 'QUARTERLY' | 'SEMIANNUALLY' | 'YEARLY'

export interface CreateSubscriptionInput {
  customer: string
  value: number
  /** YYYY-MM-DD do PRIMEIRO vencimento; as seguintes seguem o ciclo. */
  nextDueDate: string
  description: string
  billingType: AsaasBillingType
  externalReference: string
  /** Padrão MONTHLY (João/GoLink 10/09: "trabalho com assinatura, todo mês, sem término"). */
  cycle?: AsaasCycle
}

export interface AsaasSubscription {
  id: string
  customer: string
  value: number
  nextDueDate: string
  cycle: string
  status: string
  description?: string | null
}

/**
 * Assinatura sem data de fim: o Asaas gera uma cobrança por ciclo, sozinho.
 * "A criação da assinatura não confirma nenhum pagamento" — as cobranças
 * entram na carteira pela sincronização/webhook conforme nascem.
 */
export async function createSubscription(cred: AsaasCredential, input: CreateSubscriptionInput): Promise<AsaasSubscription> {
  return asaasSend<AsaasSubscription>(cred, 'POST', '/subscriptions', {
    customer: input.customer,
    billingType: input.billingType,
    value: Number(input.value.toFixed(2)),
    nextDueDate: input.nextDueDate,
    cycle: input.cycle ?? 'MONTHLY',
    description: input.description.slice(0, 500),
    externalReference: input.externalReference,
  })
}

/** Cobranças já geradas por uma assinatura (a 1ª costuma nascer na hora). */
export async function listSubscriptionPayments(cred: AsaasCredential, subscriptionId: string): Promise<AsaasPayment[]> {
  const res = await asaasGet<AsaasList<AsaasPayment>>(cred, `/subscriptions/${encodeURIComponent(subscriptionId)}/payments`, { limit: 20 })
  return res.data ?? []
}

/** Uma cobrança pelo id — a reconsulta AO VIVO antes de lembrar/agradecer. */
export async function getPayment(cred: AsaasCredential, paymentId: string): Promise<AsaasPayment> {
  return asaasGet<AsaasPayment>(cred, `/payments/${encodeURIComponent(paymentId)}`)
}

/**
 * Move o vencimento (lacuna 3, 07/09). Para boleto o Asaas gera um novo com a
 * data nova e devolve o invoiceUrl atualizado; juros/multa passam a contar da
 * nova data — por isso quem manda é gente ou uma configuração explícita.
 */
export async function updatePaymentDueDate(cred: AsaasCredential, paymentId: string, dueDate: string): Promise<AsaasPayment> {
  return asaasSend<AsaasPayment>(cred, 'PUT', `/payments/${encodeURIComponent(paymentId)}`, { dueDate })
}

/** Cobranças PENDING que vencem entre as datas (lembrete antes do vencimento). */
export async function listPendingDueBetween(cred: AsaasCredential, fromDate: string, untilDate: string): Promise<AsaasPayment[]> {
  const out: AsaasPayment[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await asaasGet<AsaasList<AsaasPayment>>(cred, '/payments', {
      status: 'PENDING',
      'dueDate[ge]': fromDate,
      'dueDate[le]': untilDate,
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    })
    out.push(...(res.data ?? []))
    if (!res.hasMore || !res.data?.length) break
  }
  return out
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
