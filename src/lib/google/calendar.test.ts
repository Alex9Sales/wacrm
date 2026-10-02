import { describe, it, expect, vi, afterEach } from 'vitest'

import { getGoogleEvent, listGoogleEvents } from './calendar'

// ------------------------------------------------------------
// listGoogleEvents — as duas correções de 17/09, que existem porque o que
// some daqui vira reunião marcada em cima de compromisso:
//   1. paginação (maxResults é teto POR PÁGINA — agenda cheia perdia o resto)
//   2. showDeleted (sem ele, evento apagado no Google nunca libera o horário)
// ------------------------------------------------------------

type Call = { url: string }
const calls: Call[] = []

function mockPages(pages: { items: { id: string }[]; nextPageToken?: string }[]) {
  let i = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push({ url: String(url) })
      const page = pages[Math.min(i, pages.length - 1)]
      i += 1
      return { ok: true, json: async () => page } as unknown as Response
    }),
  )
}

afterEach(() => {
  calls.length = 0
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('listGoogleEvents', () => {
  it('segue o nextPageToken e junta todas as páginas', async () => {
    mockPages([
      { items: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' },
      { items: [{ id: 'c' }] },
    ])

    const out = await listGoogleEvents('tok', 'cal@group', '2026-09-01T00:00:00Z', '2026-11-01T00:00:00Z')

    expect(out.map((e) => e.id)).toEqual(['a', 'b', 'c'])
    expect(calls).toHaveLength(2)
    expect(calls[0].url).not.toContain('pageToken')
    expect(calls[1].url).toContain('pageToken=p2')
  })

  it('pede os apagados só quando mandam (showDeleted)', async () => {
    mockPages([{ items: [] }])
    await listGoogleEvents('tok', 'c', 'a', 'b')
    expect(calls[0].url).not.toContain('showDeleted')

    calls.length = 0
    mockPages([{ items: [] }])
    await listGoogleEvents('tok', 'c', 'a', 'b', { showDeleted: true })
    expect(calls[0].url).toContain('showDeleted=true')
  })

  it('não entra em loop se o Google insistir em mandar nextPageToken', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockPages([{ items: [{ id: 'x' }], nextPageToken: 'sempre' }])
    const out = await listGoogleEvents('tok', 'c', 'a', 'b')
    // Teto de 10 páginas — devolve o que juntou em vez de girar pra sempre.
    expect(calls.length).toBe(10)
    expect(out).toHaveLength(10)
  })

  // 02/10: a varredura de fantasmas do sync só pode rodar com a lista inteira.
  it('avisa no `resultado` quando a lista parou no teto (truncada)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockPages([{ items: [{ id: 'x' }], nextPageToken: 'sempre' }])
    const resultado = { truncated: false }
    await listGoogleEvents('tok', 'c', 'a', 'b', { showDeleted: true, resultado })
    expect(resultado.truncated).toBe(true)
  })

  it('lista que acabou sozinha não é truncada — nem se o objeto chegar sujo', async () => {
    mockPages([{ items: [{ id: 'a' }], nextPageToken: 'p2' }, { items: [{ id: 'b' }] }])
    const resultado = { truncated: true }
    await listGoogleEvents('tok', 'c', 'a', 'b', { resultado })
    expect(resultado.truncated).toBe(false)
  })

  it('erro do Google sobe (o chamador grava em last_sync_error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, text: async () => 'invalid_grant' }) as unknown as Response),
    )
    await expect(listGoogleEvents('tok', 'c', 'a', 'b')).rejects.toThrow(/401/)
  })
})

// ------------------------------------------------------------
// getGoogleEvent — a pergunta que a varredura de fantasmas faz antes de
// cancelar qualquer coisa (02/10). "Não existe" só com 404/410; o resto LANÇA,
// porque "não consegui perguntar" não pode virar "pode cancelar".
// ------------------------------------------------------------

function mockGet(status: number, body: unknown = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push({ url: String(url) })
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response
    }),
  )
}

describe('getGoogleEvent', () => {
  it('404 e 410 → gone', async () => {
    mockGet(404)
    await expect(getGoogleEvent('tok', 'c', 'e')).resolves.toEqual({ status: 'gone' })
    mockGet(410)
    await expect(getGoogleEvent('tok', 'c', 'e')).resolves.toEqual({ status: 'gone' })
  })

  it('200 devolve o evento — inclusive a lápide do evento movido (cancelled, 1999)', async () => {
    const lapide = {
      id: 'g-movido',
      status: 'cancelled',
      start: { dateTime: '1999-12-31T22:00:00-02:00' },
      end: { dateTime: '1999-12-31T23:00:00-02:00' },
    }
    mockGet(200, lapide)
    await expect(getGoogleEvent('tok', 'c', 'g-movido')).resolves.toEqual(lapide)
  })

  it('pergunta NA agenda pedida, com agenda e id codificados na URL', async () => {
    mockGet(200, { id: 'x', status: 'confirmed' })
    await getGoogleEvent('tok', 'dona@group.calendar.google.com', 'abc_20261003T170000Z')
    expect(calls[0].url).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/dona%40group.calendar.google.com/events/abc_20261003T170000Z',
    )
  })

  it('401, 403, 429 e 500 LANÇAM (nunca viram "não existe")', async () => {
    for (const status of [401, 403, 429, 500]) {
      mockGet(status, { error: 'x' })
      await expect(getGoogleEvent('tok', 'c', 'e')).rejects.toThrow(new RegExp(`\\(${status}\\)`))
    }
  })
})
