// ============================================================
// Cliente da API do Asaas — gateway de pagamento da assinatura do FluxiaCRM.
//
// Credenciais por AMBIENTE via env (é a conta Asaas da Fluxia, não por-cliente):
//   • ASAAS_API_KEY    — a chave da conta (Sandbox p/ testar, Produção depois).
//   • ASAAS_ENV        — 'production' | 'sandbox' (default: sandbox).
//   • ASAAS_BASE_URL   — override opcional da base (ex.: se o Asaas mudar a URL).
//
// Fluxo do checkout: cria/acha o customer → cria a assinatura mensal
// (billingType UNDEFINED → o cliente escolhe Pix/boleto/cartão na tela do Asaas)
// → pega a invoiceUrl da 1ª cobrança pra redirecionar. A confirmação do
// pagamento chega pelo webhook (/api/webhooks/asaas) e vira o status pra 'active'.
// ============================================================

export class AsaasError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'AsaasError'
    this.status = status
  }
}

/**
 * Normaliza a chave do Asaas. A API exige o `$` inicial (`$aact_…`), mas esse
 * `$` some quando o valor passa pelo env_file do docker-compose (interpolação).
 * Então aceitamos a chave COM ou SEM `$` (ou `$$`) e garantimos exatamente um.
 * Retorna undefined se não houver chave. Exportada só p/ teste.
 */
export function normalizeAsaasKey(
  raw: string | undefined | null,
): string | undefined {
  const t = (raw ?? '').trim()
  if (!t) return undefined
  return '$' + t.replace(/^\$+/, '')
}

function apiKey(): string | undefined {
  return normalizeAsaasKey(process.env.ASAAS_API_KEY)
}

/** true quando a chave do Asaas está no ambiente. */
export function asaasConfigured(): boolean {
  return !!apiKey()
}

function baseUrl(): string {
  const explicit = process.env.ASAAS_BASE_URL
  if (explicit) return explicit.replace(/\/+$/, '')
  return process.env.ASAAS_ENV === 'production'
    ? 'https://api.asaas.com/v3'
    : 'https://api-sandbox.asaas.com/v3'
}

async function asaasFetch<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const key = apiKey()
  if (!key) throw new AsaasError('Asaas não configurado (ASAAS_API_KEY ausente).')
  let res: Response
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        access_token: key,
        'Content-Type': 'application/json',
        'User-Agent': 'FluxiaCRM',
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })
  } catch (err) {
    throw new AsaasError(
      `Falha de rede ao falar com o Asaas: ${err instanceof Error ? err.message : 'erro'}`,
    )
  }
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* corpo não-JSON */
  }
  if (!res.ok) {
    const j = json as { errors?: { description?: string }[]; message?: string } | null
    const msg =
      j?.errors?.[0]?.description || j?.message || `Asaas respondeu HTTP ${res.status}`
    throw new AsaasError(msg, res.status)
  }
  return json as T
}

export interface AsaasCustomer {
  id: string
  name?: string
  email?: string
  cpfCnpj?: string
}

/** Acha um customer pelo CPF/CNPJ (evita duplicar). Retorna o id ou null. */
export async function findCustomerByCpfCnpj(cpfCnpj: string): Promise<string | null> {
  const r = await asaasFetch<{ data?: AsaasCustomer[] }>(
    `/customers?cpfCnpj=${encodeURIComponent(cpfCnpj)}`,
  )
  return r.data?.[0]?.id ?? null
}

export interface CreateCustomerInput {
  name: string
  email: string
  cpfCnpj: string
  mobilePhone?: string
  /** id da organização — pra amarrar o pagamento à conta no webhook. */
  externalReference?: string
}

export async function createCustomer(input: CreateCustomerInput): Promise<string> {
  const r = await asaasFetch<AsaasCustomer>('/customers', {
    method: 'POST',
    body: input,
  })
  return r.id
}

/** Acha pelo CPF/CNPJ ou cria. Retorna o id do customer. */
export async function findOrCreateCustomer(
  input: CreateCustomerInput,
): Promise<string> {
  const existing = await findCustomerByCpfCnpj(input.cpfCnpj)
  if (existing) return existing
  return createCustomer(input)
}

export interface CreateSubscriptionInput {
  customer: string
  value: number
  /** 'YYYY-MM-DD' — 1º vencimento (hoje). */
  nextDueDate: string
  description: string
  externalReference?: string
  cycle?: 'MONTHLY'
}

export interface AsaasSubscription {
  id: string
  status?: string
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<AsaasSubscription> {
  return asaasFetch<AsaasSubscription>('/subscriptions', {
    method: 'POST',
    body: {
      billingType: 'UNDEFINED', // cliente escolhe Pix/boleto/cartão na fatura
      cycle: 'MONTHLY',
      ...input,
    },
  })
}

/** invoiceUrl da 1ª cobrança da assinatura (tela de pagamento do Asaas). */
export async function firstInvoiceUrl(subscriptionId: string): Promise<string | null> {
  const r = await asaasFetch<{ data?: { invoiceUrl?: string }[] }>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}/payments`,
  )
  return r.data?.[0]?.invoiceUrl ?? null
}
