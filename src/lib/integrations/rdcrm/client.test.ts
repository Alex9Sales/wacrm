import { afterEach, describe, it, expect, vi } from 'vitest'
import { isRdRejection, RdCrmError, rdActivityText, rdCrm } from './client'

describe('rdActivityText', () => {
  it('tira acento, cedilha e travessão — o /activities do RD grava torto', () => {
    expect(rdActivityText('Ganho via FluxiaCRM — IA marcou a reunião para segunda-feira, 21/09, às 9h.')).toBe(
      'Ganho via FluxiaCRM - IA marcou a reuniao para segunda-feira, 21/09, as 9h.',
    )
    expect(rdActivityText('Serviço – orçamento de ÁREA ÚTIL')).toBe('Servico - orcamento de AREA UTIL')
  })

  it('mantém quebra de linha e some com emoji', () => {
    expect(rdActivityText('Linha 1\nLinha 2 📅')).toBe('Linha 1\nLinha 2 ')
  })

  it('texto já sem acento passa igual', () => {
    expect(rdActivityText('Ganho via FluxiaCRM.')).toBe('Ganho via FluxiaCRM.')
  })

  it('separador e aspas tipográficas viram ASCII em vez de sumir (palavras não colam)', () => {
    expect(rdActivityText('Origem do lead (FluxiaCRM): Franquia · Facebook Ads')).toBe(
      'Origem do lead (FluxiaCRM): Franquia - Facebook Ads',
    )
    expect(rdActivityText('Cadência «Pré-vendas» — toque 2 enviado (WhatsApp)')).toBe(
      'Cadencia "Pre-vendas" - toque 2 enviado (WhatsApp)',
    )
    expect(rdActivityText('disse “talvez” e ‘depois’')).toBe(`disse "talvez" e 'depois'`)
  })
})

describe('isRdRejection', () => {
  it('4xx de conteúdo é recusa; 429, 5xx e erro de rede não são', () => {
    expect(isRdRejection(new RdCrmError(422, 'x'))).toBe(true)
    expect(isRdRejection(new RdCrmError(400, 'x'))).toBe(true)
    expect(isRdRejection(new RdCrmError(429, 'x'))).toBe(false)
    expect(isRdRejection(new RdCrmError(500, 'x'))).toBe(false)
    expect(isRdRejection(new Error('timeout'))).toBe(false)
  })
})

describe('chamadas de negócio e tarefa (fetch simulado)', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubFetch(responses: { status?: number; body: unknown }[]) {
    const calls: { method: string; url: URL; body: unknown }[] = []
    const queue = [...responses]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        calls.push({
          method: String(init.method),
          url: new URL(String(url)),
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        })
        const r = queue.shift() ?? { body: {} }
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
      }),
    )
    return calls
  }

  it('createDeal manda o corpo como veio (campaign/deal_source no topo, campos dentro de deal)', async () => {
    const calls = stubFetch([{ body: { _id: 'novo' } }])
    const body = {
      deal: { name: 'Fulana', deal_stage_id: 's3', deal_custom_fields: [{ custom_field_id: 'cf', value: 'v' }] },
      campaign: { _id: 'camp1' },
      deal_source: { _id: 'src1' },
    }
    await rdCrm('tok').createDeal(body)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url.pathname).toBe('/api/v1/deals')
    expect(calls[0].body).toEqual(body)
  })

  it('listDealTasks filtra pelo negócio e devolve a lista', async () => {
    const calls = stubFetch([{ body: { total: 1, has_more: false, tasks: [{ id: 't1', subject: 'X' }] } }])
    const tasks = await rdCrm('tok').listDealTasks('d1')
    expect(tasks).toEqual([{ id: 't1', subject: 'X' }])
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url.pathname).toBe('/api/v1/tasks')
    expect(calls[0].url.searchParams.get('deal_id')).toBe('d1')
  })

  it('createTask/updateTask leem a tarefa solta ou dentro de "task"', async () => {
    stubFetch([{ body: { task: { id: 't1', done: true } } }, { body: { _id: 't2', done: false } }])
    const api = rdCrm('tok')
    expect(await api.createTask({ task: { subject: 'x' } })).toEqual({ id: 't1', done: true })
    expect(await api.updateTask('t2', { task: { done: true } })).toEqual({ _id: 't2', done: false })
  })

  it('recusa do RD vira RdCrmError com o status (sem o token na mensagem)', async () => {
    stubFetch([{ status: 422, body: { errors: { deal_custom_fields: ['inválido'] } } }])
    const err = await rdCrm('segredo-123')
      .createDeal({})
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RdCrmError)
    expect((err as RdCrmError).status).toBe(422)
    expect((err as Error).message).not.toContain('segredo-123')
  })
})
