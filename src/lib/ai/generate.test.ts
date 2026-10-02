import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateReply, parseGeneration } from './generate'
import { AiError, type AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyChannelIds: [],
    autoReplyMaxPerConversation: 3,
    autoReplyHoursMode: 'always',
    embeddingsApiKey: null,
    signatureName: null,
    signatureEnabled: false,
    ...overrides,
  }
}

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('parseGeneration', () => {
  it('returns text with no handoff', () => {
    expect(parseGeneration('Hello there')).toEqual({
      text: 'Hello there',
      handoff: false,
    })
  })

  it('detects + strips the handoff sentinel', () => {
    expect(parseGeneration('[[HANDOFF]]')).toEqual({ text: '', handoff: true })
    expect(parseGeneration('Let me get a human [[HANDOFF]]')).toEqual({
      text: 'Let me get a human',
      handoff: true,
    })
  })

  // 02/10/2026: o modelo que fecha "[[RESUMO:…] ]" também escreve o sentinel
  // do jeito dele — a transferência não pode se perder por isso.
  it('handoff tolerante: minúsculas, espaços, "] ]", "]\\n]" e "]" só', () => {
    for (const raw of ['[[handoff]]', '[[ HANDOFF ]]', '[[HANDOFF] ]', '[[Handoff]\n]', '[[HANDOFF]']) {
      expect(parseGeneration(raw)).toEqual({ text: '', handoff: true })
    }
  })

  it('o caso real: o resumo mal fechado continua no texto (quem tira é parseCloseDirectives)', () => {
    expect(parseGeneration('[[HANDOFF]]\n[[RESUMO:Cliente quer o kit] ]')).toEqual({
      text: '[[RESUMO:Cliente quer o kit] ]',
      handoff: true,
    })
  })

  it('[[HANDOFF_…]] (outro nome) não é transferência', () => {
    expect(parseGeneration('Oi [[HANDOFF_X]]')).toEqual({ text: 'Oi [[HANDOFF_X]]', handoff: false })
  })

  // 02/10/2026, revisão 2: SEM fechar também. A rede do envio já tirava
  // "[[HANDOFF" do texto e, como o HANDOFF não gera aviso, a transferência
  // sumia sem rastro.
  it('handoff sem fechar: no fim do texto, no fim da linha ou antes do próximo "[["', () => {
    expect(parseGeneration('Já te passo pro responsável.\n[[HANDOFF')).toEqual({
      text: 'Já te passo pro responsável.',
      handoff: true,
    })
    expect(parseGeneration('[[HANDOFF\nJá te passo pro responsável.')).toEqual({
      text: 'Já te passo pro responsável.',
      handoff: true,
    })
    expect(parseGeneration('[[HANDOFF [[RESUMO:Ana]]')).toEqual({ text: '[[RESUMO:Ana]]', handoff: true })
  })

  it('"[[HANDOFF" com texto na mesma linha não é transferência', () => {
    expect(parseGeneration('[[HANDOFF agora')).toEqual({ text: '[[HANDOFF agora', handoff: false })
  })
})

describe('generateReply — OpenAI', () => {
  it('calls the chat completions endpoint and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'Sure — happy to help!' } }],
        // OpenAI: prompt_tokens JÁ inclui os cacheados (cached é subconjunto).
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res).toMatchObject({ text: 'Sure — happy to help!', handoff: false })
    // Medidor de custo (Fase B): tokens normalizados (prompt = TOTAL de input).
    expect(res.usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      cachedReadTokens: 40,
      cacheCreationTokens: 0,
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(401, { error: { message: 'Incorrect API key' } }),
      ),
    )

    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('throws on an empty completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })),
    )
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toBeInstanceOf(AiError)
  })
})

describe('generateReply — Anthropic', () => {
  it('calls the messages endpoint with the version header and parses text blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'text', text: 'Hi there!' }],
        // Anthropic: input_tokens é o NÃO-cacheado; cache_read/creation são
        // separados — normalizamos prompt = 50 + 30 + 5 = 85.
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 5,
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    expect(res).toMatchObject({ text: 'Hi there!', handoff: false })
    // Medidor de custo (Fase B): prompt = input + cache_read + cache_creation.
    expect(res.usage).toEqual({
      promptTokens: 85,
      completionTokens: 10,
      cachedReadTokens: 30,
      cacheCreationTokens: 5,
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    expect(opts.headers['x-api-key']).toBe('sk-ant-x')
    expect(opts.headers['anthropic-version']).toBeTruthy()
  })

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: '[[HANDOFF]]' }] }),
      ),
    )
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want to speak to a person' }],
    })
    expect(res.handoff).toBe(true)
    expect(res.text).toBe('')
  })

  it('drops a leading assistant turn so the payload starts on the customer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages).toHaveLength(1)
  })
})
