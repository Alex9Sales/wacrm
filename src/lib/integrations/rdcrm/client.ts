// ============================================================
// Cliente mínimo da API v1 do RD Station CRM (token de instância na query).
//
// Comportamentos CONFIRMADOS ao vivo em 18/09 (negócios de teste numa conta de
// cliente), onde a documentação se contradiz:
//   • mover etapa: {"deal_stage_id"} no topo do corpo; trocar de FUNIL é só
//     mandar uma etapa de outro funil;
//   • perder: {"deal":{"win":false,"deal_lost_reason_id","deal_lost_note"}};
//   • negócio FECHADO (ganho/perdido) NÃO reabre pela API — win:null,
//     closed_at:null e win:true são ignorados em silêncio (200);
//   • contato existente entra num negócio novo via PUT /contacts/:id
//     {contact:{deal_ids:[…todos…]}}. POST /deals com "contacts" cria um
//     contato NOVO (duplicaria o do lead);
//   • GET /contacts?email= e ?phone= (aceita +55…, 55… e o número nacional).
// Limite do RD: 120 requisições/min — 429 espera e tenta de novo.
// Sem 'server-only' — roda no worker.
// ============================================================

const BASE = 'https://crm.rdstation.com/api/v1'

export class RdCrmError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'RdCrmError'
  }
}

type Ref = { id?: string; _id?: string; name?: string }

export interface RdStage extends Ref {
  order?: number
  deal_pipeline_id?: string
}
export interface RdPipeline extends Ref {
  deal_stages?: RdStage[]
}
export interface RdDeal extends Ref {
  win?: boolean | null
  hold?: boolean | null
  closed_at?: string | null
  created_at?: string
  deal_stage?: RdStage
  deal_pipeline?: Ref
  user?: Ref & { email?: string }
  deal_lost_reason?: Ref | null
}
export interface RdContact extends Ref {
  emails?: { email?: string }[]
  phones?: { phone?: string }[]
  deals?: (Ref & { win?: boolean | null; closed_at?: string | null })[]
  deal_ids?: string[]
}
export interface RdUser extends Ref {
  email?: string
  active?: boolean
}

/** O RD devolve `_id` e `id` iguais — às vezes só um dos dois. */
export function rid(x: Ref | null | undefined): string | null {
  return (x?.id || x?._id || null) ?? null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function rdCrm(token: string) {
  async function call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(BASE + path)
    url.searchParams.set('token', token)
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v)
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 429 && attempt < 2) {
        await sleep(3_000 * (attempt + 1))
        continue
      }
      const text = await res.text()
      if (!res.ok) {
        // Erro 500 do RD pode vir em HTML — nunca assume JSON aqui. O token vai
        // na query: a mensagem cita só o caminho, nunca a URL inteira.
        throw new RdCrmError(res.status, `RD CRM ${method} ${path} (${res.status}): ${text.slice(0, 300)}`)
      }
      if (!text) return {} as T
      try {
        return JSON.parse(text) as T
      } catch {
        throw new RdCrmError(res.status, `RD CRM ${method} ${path}: resposta não é JSON`)
      }
    }
  }

  return {
    listPipelines: () => call<RdPipeline[]>('GET', '/deal_pipelines', { query: { limit: '200' } }),
    listUsers: async () => (await call<{ users?: RdUser[] }>('GET', '/users')).users ?? [],
    listLostReasons: async () =>
      (await call<{ deal_lost_reasons?: Ref[] }>('GET', '/deal_lost_reasons', { query: { limit: '200' } }))
        .deal_lost_reasons ?? [],
    getDeal: (id: string) => call<RdDeal>('GET', `/deals/${encodeURIComponent(id)}`),
    createDeal: (body: unknown) => call<RdDeal>('POST', '/deals', { body }),
    updateDeal: (id: string, body: unknown) => call<RdDeal>('PUT', `/deals/${encodeURIComponent(id)}`, { body }),
    findContacts: async (q: { email?: string; phone?: string }) =>
      (await call<{ contacts?: RdContact[] }>('GET', '/contacts', {
        query: Object.fromEntries(Object.entries(q).filter(([, v]) => !!v)) as Record<string, string>,
      })).contacts ?? [],
    getContact: (id: string) => call<RdContact>('GET', `/contacts/${encodeURIComponent(id)}`),
    setContactDeals: (id: string, dealIds: string[]) =>
      call<RdContact>('PUT', `/contacts/${encodeURIComponent(id)}`, { body: { contact: { deal_ids: dealIds } } }),
    createActivity: (dealId: string, userId: string, text: string) =>
      call<Ref>('POST', '/activities', { body: { activity: { deal_id: dealId, user_id: userId, text } } }),
    listWebhooks: async () =>
      (await call<{ webhooks?: { uuid: string; event_type: string; url: string; status?: string }[] }>('GET', '/webhooks'))
        .webhooks ?? [],
    createWebhook: (eventType: string, url: string) =>
      call<{ uuid: string; status?: string }>('POST', '/webhooks', {
        body: { event_type: eventType, url, http_method: 'POST' },
      }),
  }
}

export type RdCrmClient = ReturnType<typeof rdCrm>
