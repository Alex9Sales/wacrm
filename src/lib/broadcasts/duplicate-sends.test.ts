import { beforeEach, describe, expect, it, vi } from 'vitest'

// 15/09 (GoLink): "dia do cliente" refeito 3× — a mesma imagem chegou 2× pra
// Flash Baterias, Piso Decor e Vidro e Cia. O db é trocado por uma fila de
// respostas (uma por consulta, na ordem: disparos, depois mensagens).
const h = vi.hoisted(() => ({
  results: [] as unknown[][],
  selectCalls: 0,
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const chain = (rows: unknown[]) => {
    const p: Record<string, unknown> = {}
    for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'limit', 'orderBy']) p[m] = () => p
    p.then = (res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej)
    return p
  }
  const db = {
    select: () => {
      const rows = h.results[h.selectCalls] ?? []
      h.selectCalls++
      return chain(rows)
    },
  }
  return { ...actual, db }
})

import {
  broadcastMediaNames,
  findRecentDuplicateContacts,
  mediaFingerprintName,
  normalizeBroadcastText,
} from './duplicate-sends'

beforeEach(() => {
  h.results = []
  h.selectCalls = 0
})

describe('normalização', () => {
  it('trim, espaços e quebras colapsados, minúsculas', () => {
    expect(normalizeBroadcastText('  Olá   CLIENTE\n\n Feliz  dia!  ')).toBe('olá cliente feliz dia!')
    expect(normalizeBroadcastText('   \n ')).toBe('')
    expect(normalizeBroadcastText(null)).toBe('')
  })

  it('nome do anexo: filename; sem ele, o fim da URL', () => {
    expect(mediaFingerprintName({ url: 'https://s/x/9f1c.jpg', filename: ' Dia do Cliente.JPG ' })).toBe(
      'dia do cliente.jpg',
    )
    expect(mediaFingerprintName({ url: 'https://s/api/files/media/ab%20c.png?t=1' })).toBe('ab c.png')
    expect(mediaFingerprintName({ url: '', filename: null })).toBeNull()
  })

  it('anexos efetivos do disparo: media[] vence a mídia única antiga', () => {
    expect(
      broadcastMediaNames({
        media: [
          { url: 'https://s/2.jpg', filename: 'B.jpg' },
          { url: 'https://s/1.jpg', filename: 'a.jpg' },
        ],
        mediaUrl: 'https://s/velha.jpg',
        mediaFilename: 'velha.jpg',
      }),
    ).toEqual(['a.jpg', 'b.jpg'])
    expect(broadcastMediaNames({ media: null, mediaUrl: 'https://s/u.jpg', mediaFilename: 'Dia.jpg' })).toEqual([
      'dia.jpg',
    ])
    expect(broadcastMediaNames({ media: null, mediaUrl: null, mediaFilename: null })).toEqual([])
  })
})

describe('findRecentDuplicateContacts', () => {
  it('lista vazia → [] sem consultar', async () => {
    expect(await findRecentDuplicateContacts('acc', [], { bodyText: 'Oi', mediaFilenames: [] })).toEqual([])
    expect(h.selectCalls).toBe(0)
  })

  it('sem texto e sem anexo → [] sem consultar', async () => {
    expect(await findRecentDuplicateContacts('acc', ['c1'], { bodyText: '  ', mediaFilenames: [] })).toEqual([])
    expect(h.selectCalls).toBe(0)
  })

  it('texto: junta disparo + envio à mão, fica com o envio mais recente e mantém a ordem', async () => {
    h.results = [
      // (i) broadcast_recipients (texto já filtrado no SQL)
      [
        { contactId: 'c2', name: 'Piso Decor', sentAt: '2026-09-15 10:00:00+00', media: null, mediaUrl: null, mediaFilename: null },
        { contactId: 'c1', name: 'Flash Baterias', sentAt: '2026-09-15 09:00:00+00', media: null, mediaUrl: null, mediaFilename: null },
      ],
      // (ii) messages
      [
        { contactId: 'c1', name: 'Flash Baterias', createdAt: '2026-09-15 11:30:00.5+00' },
        { contactId: 'c2', name: 'Piso Decor', createdAt: '2026-09-15 08:00:00+00' },
      ],
    ]
    const out = await findRecentDuplicateContacts('acc', ['c1', 'c2', 'c3', 'c1'], {
      bodyText: 'Feliz dia do cliente!',
      mediaFilenames: [],
    })
    expect(h.selectCalls).toBe(2)
    expect(out).toEqual([
      { contactId: 'c1', name: 'Flash Baterias', lastSentAt: '2026-09-15T11:30:00.500Z' },
      { contactId: 'c2', name: 'Piso Decor', lastSentAt: '2026-09-15T10:00:00.000Z' },
    ])
  })

  it('só mídia: casa pelo conjunto de nomes de arquivo e não olha mensagens', async () => {
    h.results = [
      [
        // mesma imagem subida de novo (URL nova, nome igual) → repetido
        {
          contactId: 'c1',
          name: 'Vidro e Cia',
          sentAt: '2026-09-15 09:00:00+00',
          media: [{ url: 'https://s/novo-uuid.jpg', type: 'image', filename: 'Dia do Cliente.jpg' }],
          mediaUrl: null,
          mediaFilename: null,
        },
        // outra imagem → não é o mesmo conteúdo
        {
          contactId: 'c2',
          name: 'Outra',
          sentAt: '2026-09-15 09:00:00+00',
          media: [{ url: 'https://s/x.jpg', type: 'image', filename: 'promo.jpg' }],
          mediaUrl: null,
          mediaFilename: null,
        },
        // mesma imagem + outra a mais → conjunto diferente
        {
          contactId: 'c3',
          name: 'Mais uma',
          sentAt: '2026-09-15 09:00:00+00',
          media: [
            { url: 'https://s/y.jpg', type: 'image', filename: 'dia do cliente.jpg' },
            { url: 'https://s/z.pdf', type: 'document', filename: 'tabela.pdf' },
          ],
          mediaUrl: null,
          mediaFilename: null,
        },
        // mídia única antiga com o mesmo nome → repetido
        {
          contactId: 'c4',
          name: null,
          sentAt: '2026-09-15 07:00:00+00',
          media: null,
          mediaUrl: 'https://s/old.jpg',
          mediaFilename: 'DIA DO CLIENTE.jpg',
        },
      ],
    ]
    const out = await findRecentDuplicateContacts('acc', ['c1', 'c2', 'c3', 'c4'], {
      bodyText: null,
      mediaFilenames: ['dia do cliente.jpg'],
    })
    expect(h.selectCalls).toBe(1)
    expect(out.map((d) => d.contactId)).toEqual(['c1', 'c4'])
    expect(out[1]).toEqual({ contactId: 'c4', name: null, lastSentAt: '2026-09-15T07:00:00.000Z' })
  })

  it('texto: mídia diferente não impede (o texto decide)', async () => {
    h.results = [
      [
        {
          contactId: 'c1',
          name: 'A',
          sentAt: '2026-09-15 09:00:00+00',
          media: [{ url: 'https://s/x.jpg', filename: 'outra.jpg' }],
          mediaUrl: null,
          mediaFilename: null,
        },
      ],
      [],
    ]
    const out = await findRecentDuplicateContacts('acc', ['c1'], {
      bodyText: 'Oi',
      mediaFilenames: ['dia.jpg'],
    })
    expect(out.map((d) => d.contactId)).toEqual(['c1'])
  })
})
