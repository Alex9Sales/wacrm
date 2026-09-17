import { describe, it, expect, vi, afterEach } from 'vitest'

import { listGoogleEvents } from './calendar'

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
    mockPages([{ items: [{ id: 'x' }], nextPageToken: 'sempre' }])
    const out = await listGoogleEvents('tok', 'c', 'a', 'b')
    // Teto de 10 páginas — devolve o que juntou em vez de girar pra sempre.
    expect(calls.length).toBe(10)
    expect(out).toHaveLength(10)
  })

  it('erro do Google sobe (o chamador grava em last_sync_error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, text: async () => 'invalid_grant' }) as unknown as Response),
    )
    await expect(listGoogleEvents('tok', 'c', 'a', 'b')).rejects.toThrow(/401/)
  })
})
