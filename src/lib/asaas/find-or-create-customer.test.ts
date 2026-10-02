import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AsaasDocumentRequiredError,
  findCustomer,
  findCustomerByDocument,
  findOrCreateCustomer,
  phoneForAsaasCustomer,
  type AsaasCredential,
  type AsaasCustomer,
} from './collections'

// O Asaas é falsificado no fetch: aqui interessa QUAIS chamadas saem (e,
// principalmente, que nenhum POST/PUT sai quando falta documento — 15/09,
// cadastro órfão), não o formato exato da resposta.

const PROD: AsaasCredential = { apiKey: 'k', environment: 'production' }
const SANDBOX: AsaasCredential = { apiKey: 'k', environment: 'sandbox' }
const REF = '0f0e0d0c-0b0a-4908-8706-050403020100'
const CNPJ = '11222333000181'
const OUTRO_CPF = '52998224725'

interface Call {
  method: string
  url: URL
  body: Record<string, unknown> | null
}

let calls: Call[] = []
/** Resposta das buscas: por documento e por externalReference. */
let byDoc: AsaasCustomer[] = []
let byRef: AsaasCustomer[] = []

function install() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
      calls.push({ method, url, body })
      const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) }) as unknown as Response
      if (method === 'GET' && url.pathname.endsWith('/customers')) {
        if (url.searchParams.has('cpfCnpj')) return json({ data: byDoc, hasMore: false })
        if (url.searchParams.has('externalReference')) return json({ data: byRef, hasMore: false })
      }
      if (method === 'POST') return json({ id: 'cus_novo', ...body })
      if (method === 'PUT') return json({ id: url.pathname.split('/').pop(), ...body })
      return json({})
    }),
  )
}

const writes = () => calls.filter((c) => c.method === 'POST' || c.method === 'PUT')
const input = (over: Partial<Parameters<typeof findOrCreateCustomer>[1]> = {}) => ({
  name: 'João',
  mobilePhone: '5567999991234',
  externalReference: REF,
  ...over,
})

beforeEach(() => {
  calls = []
  byDoc = []
  byRef = []
  install()
})
afterEach(() => vi.unstubAllGlobals())

describe('findOrCreateCustomer — sem documento em produção não escreve nada', () => {
  it('(1) produção, sem doc, ninguém pelo ref → AsaasDocumentRequiredError e nenhum POST/PUT', async () => {
    await expect(findOrCreateCustomer(PROD, input())).rejects.toBeInstanceOf(AsaasDocumentRequiredError)
    expect(writes()).toHaveLength(0)
    expect(calls.map((c) => c.url.searchParams.has('externalReference'))).toEqual([true])
  })

  it('(2) produção, sem doc, ref acha órfão sem CPF → rejeita e nenhum PUT (nem com endereço)', async () => {
    byRef = [{ id: 'cus_orfao', externalReference: REF, cpfCnpj: null }]
    await expect(
      findOrCreateCustomer(PROD, input({ address: { postalCode: '79000000', addressNumber: '10' }, email: 'a@b.com' })),
    ).rejects.toBeInstanceOf(AsaasDocumentRequiredError)
    expect(writes()).toHaveLength(0)
  })

  it('(3) produção, sem doc, ref acha cadastro com CPF → devolve ele sem POST', async () => {
    byRef = [{ id: 'cus_ok', externalReference: REF, cpfCnpj: OUTRO_CPF, email: 'x@y.com' }]
    const c = await findOrCreateCustomer(PROD, input())
    expect(c.id).toBe('cus_ok')
    expect(writes()).toHaveLength(0)
  })

  it('a mensagem do erro contém "CPF ou CNPJ" (quem chama reconhece como needsDocument)', () => {
    expect(new AsaasDocumentRequiredError().message).toMatch(/CPF ou CNPJ/)
    expect(new AsaasDocumentRequiredError().status).toBe(0)
  })
})

describe('findOrCreateCustomer — com documento, busca pelo documento primeiro', () => {
  it('(4) busca por CNPJ devolve [órfão, cadastro com endereço] → 1ª chamada é ?cpfCnpj, não consulta ref, usa o com endereço', async () => {
    byDoc = [
      { id: 'cus_000000000009', cpfCnpj: CNPJ, externalReference: REF, dateCreated: '2026-09-15' },
      { id: 'cus_000000000002', cpfCnpj: CNPJ, postalCode: '79000000', addressNumber: '100', dateCreated: '2025-01-10', email: 'j@g.com' },
    ]
    const c = await findOrCreateCustomer(PROD, input({ cpfCnpj: CNPJ }))
    expect(c.id).toBe('cus_000000000002')
    expect(calls[0].url.searchParams.get('cpfCnpj')).toBe(CNPJ)
    expect(calls[0].url.searchParams.get('limit')).toBe('20')
    expect(calls.some((x) => x.url.searchParams.has('externalReference'))).toBe(false)
    expect(writes()).toHaveLength(0) // nada a completar
  })

  it('(4b) com patch (e-mail que faltava) faz PUT no cadastro verdadeiro, sem externalReference', async () => {
    byDoc = [{ id: 'cus_real', cpfCnpj: CNPJ, postalCode: '79000000', addressNumber: '1' }]
    await findOrCreateCustomer(PROD, input({ cpfCnpj: CNPJ, email: 'nota@empresa.com' }))
    const put = writes()
    expect(put).toHaveLength(1)
    expect(put[0].method).toBe('PUT')
    expect(put[0].url.pathname).toMatch(/\/customers\/cus_real$/)
    expect(put[0].body).toMatchObject({ email: 'nota@empresa.com', notificationDisabled: true })
    expect(put[0].body).not.toHaveProperty('externalReference')
    expect(put[0].body).not.toHaveProperty('cpfCnpj')
  })

  it('(5) busca por documento vazia, ref acha órfão sem doc → PUT com o CNPJ no órfão e nenhum POST', async () => {
    byRef = [{ id: 'cus_orfao', externalReference: REF, cpfCnpj: '' }]
    const c = await findOrCreateCustomer(PROD, input({ cpfCnpj: '11.222.333/0001-81' }))
    expect(c.id).toBe('cus_orfao')
    const w = writes()
    expect(w).toHaveLength(1)
    expect(w[0].method).toBe('PUT')
    expect(w[0].body).toMatchObject({ cpfCnpj: CNPJ })
  })

  it('(6) busca por documento vazia, ref acha cadastro com OUTRO documento → POST novo com o CNPJ', async () => {
    byRef = [{ id: 'cus_outra_pessoa', externalReference: REF, cpfCnpj: OUTRO_CPF }]
    const c = await findOrCreateCustomer(PROD, input({ cpfCnpj: CNPJ }))
    expect(c.id).toBe('cus_novo')
    const w = writes()
    expect(w).toHaveLength(1)
    expect(w[0].method).toBe('POST')
    expect(w[0].body).toMatchObject({ cpfCnpj: CNPJ, externalReference: REF, notificationDisabled: true })
  })
})

describe('findOrCreateCustomer — sandbox e opções', () => {
  it('(7) sandbox, sem doc, nada achado → POST sem cpfCnpj (como sempre foi)', async () => {
    const c = await findOrCreateCustomer(SANDBOX, input())
    expect(c.id).toBe('cus_novo')
    const w = writes()
    expect(w).toHaveLength(1)
    expect(w[0].body).not.toHaveProperty('cpfCnpj')
  })

  it('(8) requireDocument:false explícito em produção sem doc → POST (a opção manda)', async () => {
    await findOrCreateCustomer(PROD, input({ requireDocument: false }))
    expect(writes().map((w) => w.method)).toEqual(['POST'])
  })

  it('existing: null vai direto ao POST, sem buscar de novo', async () => {
    await findOrCreateCustomer(PROD, input({ cpfCnpj: CNPJ }), { existing: null })
    expect(calls.map((c) => c.method)).toEqual(['POST'])
  })

  it('existing: cadastro pronto → nenhuma busca e nenhum PUT sem patch', async () => {
    const c = await findOrCreateCustomer(PROD, input({ cpfCnpj: CNPJ }), { existing: { id: 'cus_x', cpfCnpj: CNPJ } })
    expect(c.id).toBe('cus_x')
    expect(calls).toHaveLength(0)
  })

  it('existing: null em produção sem documento → lança antes do POST', async () => {
    await expect(findOrCreateCustomer(PROD, input(), { existing: null })).rejects.toBeInstanceOf(AsaasDocumentRequiredError)
    expect(calls).toHaveLength(0)
  })

  // Revisão 17/09 (aviso de cobrança nova): o PUT de complemento cala o Asaas.
  // Quem chama precisa saber, para gravar QUANDO o cliente parou de ser avisado.
  it('onSilenced: só quando o PUT calou um cadastro que ainda recebia avisos', async () => {
    const calados: string[] = []
    const onSilenced = (id: string) => calados.push(id)
    // Avisos ligados + e-mail que faltava → PUT com notificationDisabled → avisa.
    await findOrCreateCustomer(PROD, input({ cpfCnpj: CNPJ, email: 'nota@empresa.com' }), {
      existing: { id: 'cus_painel', cpfCnpj: CNPJ, notificationDisabled: false },
      onSilenced,
    })
    // Já calado → PUT sai, mas nada muda nos avisos.
    await findOrCreateCustomer(PROD, input({ cpfCnpj: CNPJ, email: 'nota@empresa.com' }), {
      existing: { id: 'cus_calado', cpfCnpj: CNPJ, notificationDisabled: true },
      onSilenced,
    })
    // Sem nada a completar → nenhum PUT, nada calado.
    await findOrCreateCustomer(PROD, input({ cpfCnpj: CNPJ }), { existing: { id: 'cus_pronto', cpfCnpj: CNPJ, notificationDisabled: false }, onSilenced })
    expect(calados).toEqual(['cus_painel'])
    expect(writes().map((w) => w.url.pathname.split('/').pop())).toEqual(['cus_painel', 'cus_calado'])
  })
})

describe('findCustomer / findCustomerByDocument — só leitura', () => {
  it('findCustomer nunca escreve e devolve null quando não existe', async () => {
    expect(await findCustomer(PROD, { externalReference: REF, cpfCnpj: CNPJ })).toBeNull()
    expect(writes()).toHaveLength(0)
    expect(calls).toHaveLength(2)
  })

  it('findCustomerByDocument: 1 GET, ignora apagado e documento diferente', async () => {
    byDoc = [
      { id: 'cus_apagado', cpfCnpj: CNPJ, deleted: true },
      { id: 'cus_outro', cpfCnpj: OUTRO_CPF },
    ]
    expect(await findCustomerByDocument(PROD, CNPJ)).toBeNull()
    byDoc = [{ id: 'cus_ok', cpfCnpj: CNPJ }]
    expect((await findCustomerByDocument(PROD, CNPJ))?.id).toBe('cus_ok')
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.method === 'GET' && c.url.searchParams.get('cpfCnpj') === CNPJ)).toBe(true)
  })

  it('findCustomerByDocument sem documento válido não chama o Asaas', async () => {
    expect(await findCustomerByDocument(PROD, '123')).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

// 02/10/2026: a emissão de cobrança mandava o E.164 do CRM e o Asaas lia o 55
// como DDD (o erro da Appia, agora no Asaas DO CLIENTE). O que precisa de
// teste é não trocar um erro por outro: DDD 55 (Santa Maria/RS) existe, e
// número que não é brasileiro vai em branco, não torto. Números fictícios.
describe('telefone do cliente no Asaas — nacional, sem o 55', () => {
  it.each([
    ['celular com 55 (13 dígitos) → 11', '5567999991234', '67999991234'],
    ['fixo com 55 (12 dígitos) → 10', '556732220000', '6732220000'],
    ['celular já nacional fica', '67999991234', '67999991234'],
    ['fixo já nacional fica', '6732220000', '6732220000'],
    ['DDD 55 (RS) sem DDI, celular (11) fica', '55999990000', '55999990000'],
    ['DDD 55 (RS) sem DDI, fixo (10) fica', '5532220000', '5532220000'],
    ['DDD 55 (RS) com DDI (13) → só o DDI sai', '5555999990000', '55999990000'],
    ['formatado como gente digita', '+55 (67) 99999-1234', '67999991234'],
    ['com + e 55 de país', '+5567999991234', '67999991234'],
  ])('%s', (_, raw, esperado) => {
    expect(phoneForAsaasCustomer(raw)).toBe(esperado)
  })

  it.each([
    ['estrangeiro com + (Espanha: sem o sinal parece celular de DDD 34)', '+34 912 345 678'],
    ['estrangeiro sem + (Reino Unido)', '447700900123'],
    ['55 + DDD + só 7 dígitos (GoLink 19/09)', '55129888381'],
    ['+55 que não fecha um número brasileiro', '+55985856375'],
    ['curto demais', '12345'],
    ['vazio', ''],
    ['nulo', null],
    ['indefinido', undefined],
  ])('%s → vazio', (_, raw) => {
    expect(phoneForAsaasCustomer(raw)).toBeNull()
  })

  it('o POST que cria o cliente leva o nacional, não o E.164 do CRM', async () => {
    await findOrCreateCustomer(PROD, input({ cpfCnpj: CNPJ, mobilePhone: '5567999991234' }), { existing: null })
    const [post] = writes()
    expect(post.method).toBe('POST')
    expect(post.body).toMatchObject({ mobilePhone: '67999991234' })
  })

  it('DDD 55 do RS já nacional chega intacto no POST', async () => {
    await findOrCreateCustomer(PROD, input({ cpfCnpj: CNPJ, mobilePhone: '55999990000' }), { existing: null })
    expect(writes()[0].body).toMatchObject({ mobilePhone: '55999990000' })
  })

  it('fixo (10 dígitos) vai no campo phone, não no mobilePhone', async () => {
    await findOrCreateCustomer(PROD, input({ cpfCnpj: CNPJ, mobilePhone: '556733334444' }), { existing: null })
    const body = writes()[0].body
    expect(body).toMatchObject({ phone: '6733334444' })
    expect(body).not.toHaveProperty('mobilePhone')
  })

  it('estrangeiro ou sem telefone → o campo nem vai no POST (em branco, não errado)', async () => {
    await findOrCreateCustomer(PROD, input({ cpfCnpj: CNPJ, mobilePhone: '+34 912 345 678' }), { existing: null })
    await findOrCreateCustomer(PROD, input({ cpfCnpj: CNPJ, mobilePhone: null }), { existing: null })
    await findOrCreateCustomer(PROD, input({ cpfCnpj: CNPJ, mobilePhone: '' }), { existing: null })
    const w = writes()
    expect(w).toHaveLength(3)
    for (const post of w) {
      expect(post.body).not.toHaveProperty('mobilePhone')
      expect(post.body).not.toHaveProperty('phone')
    }
  })

  it('complemento de cadastro existente (PUT) não mexe no telefone', async () => {
    byDoc = [{ id: 'cus_real', cpfCnpj: CNPJ, mobilePhone: '67999991234' }]
    await findOrCreateCustomer(PROD, input({ cpfCnpj: CNPJ, email: 'nota@empresa.com', mobilePhone: '5567988887777' }))
    const [put] = writes()
    expect(put.method).toBe('PUT')
    expect(put.body).not.toHaveProperty('mobilePhone')
  })
})
