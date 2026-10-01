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
  // Endereço (migr 0196). Todos opcionais: o Asaas abre cliente sem eles, e
  // exigir endereço para poder cobrar travaria a cobrança por causa de um dado
  // que só vai importar quando a nota fiscal entrar.
  postalCode?: string
  address?: string
  addressNumber?: string
  complement?: string
  /** BAIRRO — é isto que `province` quer dizer no Asaas. */
  province?: string
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

export interface CreatePaymentInput {
  customer: string
  value: number
  /** 'YYYY-MM-DD' */
  dueDate: string
  description: string
  externalReference?: string
}

export interface AsaasPayment {
  id: string
  status?: string
  invoiceUrl?: string
}

/**
 * Cobrança ÚNICA (28/09) — é o que um contrato semestral ou anual é de verdade.
 *
 * A regra, do Alex: "assinatura semestral é sempre o valor total dos 6 meses.
 * Ele parcela no cartão dele, mas nós recebemos o valor integral. Mesma coisa
 * seria se fosse anual." Ou seja: o compromisso longo NÃO é uma mensalidade que
 * se repete seis vezes — é um pagamento só, à vista para nós, e o parcelamento
 * (se houver) acontece entre o cliente e o cartão dele, não aqui.
 *
 * Por isso semestral/anual usa /payments e não /subscriptions: assinatura no
 * Asaas é cobrança recorrente, e criar uma com o total do semestre geraria
 * R$ 780 a cada mês. `billingType: UNDEFINED` deixa o cliente escolher Pix,
 * boleto ou cartão na fatura — foi o pedido do Rafael para a Appia.
 */
export async function createPayment(input: CreatePaymentInput): Promise<AsaasPayment> {
  return asaasFetch<AsaasPayment>('/payments', {
    method: 'POST',
    body: { billingType: 'UNDEFINED', ...input },
  })
}

/** invoiceUrl da 1ª cobrança da assinatura (tela de pagamento do Asaas). */
export async function firstInvoiceUrl(subscriptionId: string): Promise<string | null> {
  const r = await asaasFetch<{ data?: { invoiceUrl?: string }[] }>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}/payments`,
  )
  return r.data?.[0]?.invoiceUrl ?? null
}

/**
 * Cancela a assinatura no Asaas (para de gerar novas cobranças). Idempotente do
 * nosso lado: se o Asaas devolver 404 (já removida), tratamos como sucesso.
 */
export async function cancelSubscription(subscriptionId: string): Promise<void> {
  try {
    await asaasFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'DELETE',
    })
  } catch (err) {
    if (err instanceof AsaasError && err.status === 404) return // já não existe
    throw err
  }
}

/**
 * Cancela uma cobrança ÚNICA (contrato semestral/anual).
 *
 * Endpoint diferente do de assinatura de propósito — ver migr 0197. Como lá,
 * 404 é sucesso: se a cobrança não existe mais, o objetivo já está cumprido.
 */
export async function cancelPayment(paymentId: string): Promise<void> {
  try {
    await asaasFetch(`/payments/${encodeURIComponent(paymentId)}`, { method: 'DELETE' })
  } catch (err) {
    if (err instanceof AsaasError && err.status === 404) return
    throw err
  }
}

// ------------------------------------------------------------
// 🔗 Vincular uma conta do CRM a quem já existe no Asaas (24/09).
//
// Vários clientes foram cadastrados no Asaas na mão, antes de existir a
// assinatura pelo CRM: o Renato tem um parcelamento de 6× R$ 1.298,50 e o
// João uma cobrança avulsa do agente. O painel mostrava esse dinheiro como
// zero porque nada aponta pro Asaas. Aqui está o que a tela de vínculo
// precisa: achar o cliente e listar o que ele já tem.
// ------------------------------------------------------------

/** Busca clientes por nome, e-mail ou documento (o que o admin digitar). */
export async function searchCustomers(term: string): Promise<AsaasCustomer[]> {
  const q = term.trim()
  if (!q) return []
  const digits = q.replace(/\D/g, '')
  // Documento completo é busca exata: evita trazer meio mundo.
  if (digits.length === 11 || digits.length === 14) {
    const r = await asaasFetch<{ data?: AsaasCustomer[] }>(
      `/customers?cpfCnpj=${encodeURIComponent(digits)}`,
    )
    return r.data ?? []
  }
  const param = q.includes('@') ? 'email' : 'name'
  const r = await asaasFetch<{ data?: AsaasCustomer[] }>(
    `/customers?${param}=${encodeURIComponent(q)}&limit=20`,
  )
  return r.data ?? []
}

export interface AsaasSubscriptionRow {
  id: string
  value: number
  status?: string
  cycle?: string
  description?: string
  nextDueDate?: string
}

/** Assinaturas (recorrência de verdade) de um cliente. */
export async function listCustomerSubscriptions(
  customerId: string,
): Promise<AsaasSubscriptionRow[]> {
  const r = await asaasFetch<{ data?: AsaasSubscriptionRow[] }>(
    `/subscriptions?customer=${encodeURIComponent(customerId)}&limit=50`,
  )
  return r.data ?? []
}

export interface AsaasInstallmentRow {
  id: string
  /** ⚠️ No parcelamento do Asaas, `value` é o TOTAL — não a parcela. O valor
   *  de cada parcela vem em `installmentValue` (24/09: a tela mostrou
   *  "6× R$ 7.791,00" quando o certo era 6× R$ 1.298,50). */
  value: number
  installmentValue?: number
  installmentCount?: number
  description?: string
  totalValue?: number
}

/**
 * Parcelamentos do cliente — é o caso do Renato: 6× R$ 1.298,50 pela
 * implantação, que NÃO é assinatura e por isso não aparece em /subscriptions.
 */
export async function listCustomerInstallments(
  customerId: string,
): Promise<AsaasInstallmentRow[]> {
  const r = await asaasFetch<{ data?: AsaasInstallmentRow[] }>(
    `/installments?customer=${encodeURIComponent(customerId)}&limit=50`,
  )
  return r.data ?? []
}

export interface AsaasReceivedPayment {
  id: string
  customer: string
  value: number
  netValue?: number
  paymentDate?: string
  billingType?: string
  description?: string
  installmentNumber?: number
}

/**
 * Dinheiro que ENTROU num período — o que o painel chama de "recebido".
 *
 * ⚠️ Só RECEIVED e CONFIRMED contam como receita. Cobrança que "saiu da
 * carteira" (deixou de estar em aberto) NÃO quer dizer que foi paga — pode ter
 * sido cancelada ou estornada (ver crmfluxia-saiu-da-carteira-nao-e-pago).
 *
 * O filtro é por `paymentDate`, a data em que o dinheiro entrou, e não por
 * vencimento: a parcela que vence dia 30 e o cliente paga dia 2 é receita de
 * FEVEREIRO, não de janeiro.
 *
 * Pagina até o fim (o Asaas devolve 100 por vez) com um teto de segurança —
 * um painel não pode ficar preso num laço se a API mudar de comportamento.
 */
export async function listReceivedPayments(
  fromISO: string,
  toISO: string,
): Promise<AsaasReceivedPayment[]> {
  const out: AsaasReceivedPayment[] = []
  const PAGE = 100
  for (let offset = 0; offset < 2000; offset += PAGE) {
    const r = await asaasFetch<{ data?: AsaasReceivedPayment[]; hasMore?: boolean }>(
      `/payments?status=RECEIVED&paymentDate%5Bge%5D=${fromISO}&paymentDate%5Ble%5D=${toISO}` +
        `&limit=${PAGE}&offset=${offset}`,
    )
    const page = r.data ?? []
    out.push(...page)
    if (!r.hasMore || page.length === 0) break
  }
  // CONFIRMED = pago e ainda não repassado; também é dinheiro do mês.
  for (let offset = 0; offset < 2000; offset += PAGE) {
    const r = await asaasFetch<{ data?: AsaasReceivedPayment[]; hasMore?: boolean }>(
      `/payments?status=CONFIRMED&paymentDate%5Bge%5D=${fromISO}&paymentDate%5Ble%5D=${toISO}` +
        `&limit=${PAGE}&offset=${offset}`,
    )
    const page = r.data ?? []
    out.push(...page)
    if (!r.hasMore || page.length === 0) break
  }
  return out
}

type OpenCharge = {
  id: string
  value: number
  dueDate: string
  invoiceUrl?: string
  status?: string
  /** Cobrança removida no Asaas: o GET por id ainda a devolve, com o último status. */
  deleted?: boolean | null
}

/**
 * A cobrança em aberto DESTA assinatura — a que o lembrete e a trava cobram.
 *
 * ⚠️ 30/09/2026 (GoLink): `nextOpenCharge` busca a próxima cobrança do CLIENTE.
 * O cliente do João no Asaas tem 11 parcelas pendentes de OUTRO produto (o
 * "Agente de Cobrança", 12× R$ 249,75). No dia do vencimento a ordem das datas
 * salvava; do dia seguinte em diante a mensalidade vencida virava OVERDUE, saía
 * do filtro PENDING, e o lembrete passava a mostrar R$ 249,75 com o botão
 * "Pagar agora" apontando para a parcela errada.
 *
 * Ordem de preferência: a assinatura → a cobrança avulsa (semestral/anual) →
 * só então o cliente, para quem ainda não tem vínculo gravado.
 *
 * `includeOverdue`: depois do vencimento, a que importa é a VENCIDA mais antiga
 * — é ela que o cliente precisa pagar para destravar.
 */
export async function openChargeForBilling(
  link: { subscriptionId?: string | null; paymentId?: string | null; customerId?: string | null },
  opts: { includeOverdue?: boolean } = {},
): Promise<OpenCharge | null> {
  if (link.subscriptionId) {
    const sub = encodeURIComponent(link.subscriptionId)
    if (opts.includeOverdue) {
      const vencidas = await asaasFetch<{ data?: OpenCharge[] }>(
        `/payments?subscription=${sub}&status=OVERDUE&limit=1&order=asc&sort=dueDate`,
      )
      // Nada vencido = a fatura do aviso de "em aberto" já foi paga. Cair na
      // PENDING aqui seria cobrar como "em aberto" a mensalidade do mês
      // SEGUINTE, que nem venceu. Melhor nenhuma do que a errada.
      return vencidas.data?.[0] ?? null
    }
    const abertas = await asaasFetch<{ data?: OpenCharge[] }>(
      `/payments?subscription=${sub}&status=PENDING&limit=1&order=asc&sort=dueDate`,
    )
    return abertas.data?.[0] ?? null
  }
  if (link.paymentId) {
    const p = await asaasFetch<OpenCharge>(`/payments/${encodeURIComponent(link.paymentId)}`)
    if (!p?.status || p.deleted) return null
    if (p.status === 'PENDING' || (opts.includeOverdue && p.status === 'OVERDUE')) return p
    return null // paga, estornada ou cancelada: não há o que cobrar
  }
  // Só o cliente, sem assinatura nem cobrança vinculada: no "em aberto" não dá
  // para saber qual das cobranças dele é a mensalidade (a GoLink tem parcelas de
  // outro produto no mesmo cliente). Sem botão é melhor que botão errado.
  if (link.customerId) return opts.includeOverdue ? null : nextOpenCharge(link.customerId)
  return null
}

/**
 * A situação, no Asaas, da cobrança que a trava de inadimplência quer suspender.
 *
 * O banco pode estar atrasado em relação ao Asaas (webhook perdido, boleto
 * compensando), então a trava nunca suspende pelo banco: pergunta aqui antes.
 *
 * - `vencida`: existe cobrança OVERDUE nesse vínculo — a mais antiga.
 * - `paga`: a cobrança do vencimento que o banco conhece está paga. É o sinal
 *   de webhook perdido: o cliente pagou e o banco não soube.
 * - `nada_em_aberto`: nem vencida, nem paga naquela data.
 */
export async function situacaoDaCobranca(
  link: { subscriptionId?: string | null; paymentId?: string | null },
  dueDateYmd: string | null,
): Promise<
  | { tipo: 'vencida'; dueDate: string; invoiceUrl: string | null; paymentId: string }
  | { tipo: 'paga' }
  | { tipo: 'nada_em_aberto' }
> {
  const PAGA = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'])
  if (link.subscriptionId) {
    const sub = encodeURIComponent(link.subscriptionId)
    const vencidas = await asaasFetch<{ data?: OpenCharge[] }>(
      `/payments?subscription=${sub}&status=OVERDUE&limit=1&order=asc&sort=dueDate`,
    )
    const v = vencidas.data?.[0]
    if (v) return { tipo: 'vencida', dueDate: v.dueDate, invoiceUrl: v.invoiceUrl ?? null, paymentId: v.id }
    if (dueDateYmd) {
      const naData = await asaasFetch<{ data?: OpenCharge[] }>(
        `/payments?subscription=${sub}&dueDate%5Bge%5D=${dueDateYmd}&dueDate%5Ble%5D=${dueDateYmd}&limit=5`,
      )
      if ((naData.data ?? []).some((p) => p.status && PAGA.has(p.status))) return { tipo: 'paga' }
    }
    return { tipo: 'nada_em_aberto' }
  }
  if (link.paymentId) {
    const p = await asaasFetch<OpenCharge>(`/payments/${encodeURIComponent(link.paymentId)}`)
    // Removida no Asaas (cancelamento pelo /admin): não é dívida, mesmo que o
    // GET ainda mostre OVERDUE.
    if (!p || p.deleted) return { tipo: 'nada_em_aberto' }
    if (p.status === 'OVERDUE') {
      return { tipo: 'vencida', dueDate: p.dueDate, invoiceUrl: p.invoiceUrl ?? null, paymentId: p.id }
    }
    if (p.status && PAGA.has(p.status)) return { tipo: 'paga' }
    return { tipo: 'nada_em_aberto' }
  }
  return { tipo: 'nada_em_aberto' }
}

/** Próxima cobrança em aberto do cliente (pro painel dizer quando vence). */
export async function nextOpenCharge(
  customerId: string,
): Promise<{ id: string; value: number; dueDate: string; invoiceUrl?: string } | null> {
  const r = await asaasFetch<{
    data?: { id: string; value: number; dueDate: string; invoiceUrl?: string }[]
  }>(
    `/payments?customer=${encodeURIComponent(customerId)}&status=PENDING&limit=1&order=asc&sort=dueDate`,
  )
  return r.data?.[0] ?? null
}
