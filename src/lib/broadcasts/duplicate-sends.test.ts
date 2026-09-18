import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

// 15/09 (GoLink): "dia do cliente" refeito 3× — a mesma imagem chegou 2× pra
// Flash Baterias, Pisos Modelo e Vidro e Cia. O db é trocado por uma fila de
// respostas (uma por consulta, na ordem: disparos, depois mensagens). O
// `where` de cada consulta fica guardado pra conferir o SQL gerado (filtros
// que o mock não aplica: fila ativa, assunto, disparo atual).
const h = vi.hoisted(() => ({
  results: [] as unknown[][],
  selectCalls: 0,
  wheres: [] as unknown[],
  limits: [] as number[],
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const chain = (rows: unknown[]) => {
    const p: Record<string, unknown> = {}
    for (const m of ['from', 'innerJoin', 'leftJoin', 'orderBy']) p[m] = () => p
    p.where = (w: unknown) => {
      h.wheres.push(w)
      return p
    }
    p.limit = (n: number) => {
      h.limits.push(n)
      return p
    }
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
  contactAlreadyReceivedElsewhere,
  findRecentDuplicateContacts,
  isGenericFilename,
  mediaFingerprintName,
  normalizeBroadcastText,
  attachmentsClearlyDiffer,
  sameAttachmentSet,
  templateSendKey,
} from './duplicate-sends'

const dialect = new PgDialect()
const renderWhere = (i: number) => dialect.sqlToQuery(h.wheres[i] as SQL)

beforeEach(() => {
  h.results = []
  h.selectCalls = 0
  h.wheres = []
  h.limits = []
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

// Revisão 15/09: "image.png" de hoje não é o "image.png" de ontem.
describe('nome de arquivo genérico', () => {
  it.each([
    'image.png',
    'image.jpg',
    'Imagem (2).jpeg',
    'IMG_1234.jpg',
    'IMG-20260915-WA0001.jpg',
    'IMG_1234 (1).JPG',
    'VID_20260915_101010.mp4',
    'PXL_20260915_123456789.jpg',
    'WhatsApp Image.jpeg',
    'WhatsApp Image (2).jpeg',
    'Design sem nome.png',
    'Design sem nome (3).png',
    'Untitled design.png',
    'Captura de Tela.png',
    'Screenshot.png',
    'unnamed.jpg',
    'unnamed (1).png',
    '1726400000000.jpg',
    '20260915_101010.jpg',
    'arquivo.pdf',
    'documento.pdf',
    'foto - cópia.jpg',
    '',
  ])('%s é genérico', (name) => {
    expect(isGenericFilename(name)).toBe(true)
  })

  // Conferência 15/09: com data e hora até os segundos, o nome identifica.
  it.each([
    'Dia do Cliente.jpg',
    'tabela-precos-setembro.pdf',
    'promo 2026.png',
    'catalogo golink.pdf',
    'printer.png',
    'WhatsApp Image 2026-09-15 at 08.44.10.jpeg',
    'WhatsApp Image 2026-09-15 at 08.44.10 (1).jpeg',
    'Captura de Tela 2026-09-15 às 10.00.00.png',
    'Screenshot 2026-09-15 101010.png',
    'Screenshot_20260915-101010.png',
  ])(
    '%s identifica o arquivo',
    (name) => {
      expect(isGenericFilename(name)).toBe(false)
    },
  )

  it('mesmos anexos: só os nomes que identificam contam, e a quantidade tem que bater', () => {
    expect(sameAttachmentSet(['dia do cliente.jpg'], ['dia do cliente.jpg'])).toBe(true)
    expect(sameAttachmentSet(['image.png'], ['image.png'])).toBe(false)
    expect(sameAttachmentSet(['dia do cliente.jpg', 'image.png'], ['dia do cliente.jpg', 'img_99.jpg'])).toBe(true)
    // um anexo a mais pode ser conteúdo novo
    expect(sameAttachmentSet(['dia do cliente.jpg'], ['dia do cliente.jpg', 'image.png'])).toBe(false)
    expect(sameAttachmentSet([], [])).toBe(false)
  })

  it('com texto igual, anexos só desempatam quando são claramente outros', () => {
    expect(attachmentsClearlyDiffer(['oferta-segunda.jpg'], ['oferta-terca.jpg'])).toBe(true)
    expect(attachmentsClearlyDiffer([], ['oferta-terca.jpg'])).toBe(true)
    expect(attachmentsClearlyDiffer(['dia do cliente.jpg'], ['Dia do Cliente.jpg'])).toBe(false)
    // nada que identifique dos dois lados: o texto decide
    expect(attachmentsClearlyDiffer(['image.png'], ['img_99.jpg'])).toBe(false)
    expect(attachmentsClearlyDiffer([], [])).toBe(false)
  })
})

describe('templateSendKey', () => {
  it('corpo + cabeçalho de texto + botões; mídia do cabeçalho não entra', () => {
    const a = templateSendKey({
      params: ['Flash Baterias', '15/09'],
      messageParams: { headerText: 'Oi', headerMediaUrl: 'https://s/1.jpg', buttonParams: { 1: 'x', 0: 'y' } },
    })
    const b = templateSendKey({
      params: ['Flash Baterias', '15/09'],
      messageParams: { headerText: 'Oi', headerMediaUrl: 'https://s/2.jpg', buttonParams: { 0: 'y', 1: 'x' } },
    })
    expect(a).toBe(b)
    expect(templateSendKey({ params: ['Pisos Modelo', '15/09'], messageParams: null })).not.toBe(
      templateSendKey({ params: ['Flash Baterias', '15/09'], messageParams: null }),
    )
    expect(templateSendKey({ params: ['A'], messageParams: { headerText: 'Oi' } })).not.toBe(
      templateSendKey({ params: ['A'], messageParams: { headerText: 'Olá' } }),
    )
    expect(templateSendKey({ params: ['A'], messageParams: { buttonParams: { 0: 'cupom1' } } })).not.toBe(
      templateSendKey({ params: ['A'], messageParams: { buttonParams: { 0: 'cupom2' } } }),
    )
    // sem valor no botão = sem botão; sem cabeçalho = cabeçalho vazio
    expect(templateSendKey({ params: [], messageParams: { buttonParams: { 0: '' }, headerText: '' } })).toBe(
      templateSendKey({ params: [], messageParams: undefined }),
    )
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
        { contactId: 'c2', name: 'Pisos Modelo', status: 'sent', sentAt: '2026-09-15 10:00:00+00', media: null, mediaUrl: null, mediaFilename: null },
        { contactId: 'c1', name: 'Flash Baterias', status: 'delivered', sentAt: '2026-09-15 09:00:00+00', media: null, mediaUrl: null, mediaFilename: null },
      ],
      // (ii) messages
      [
        { contactId: 'c1', name: 'Flash Baterias', createdAt: '2026-09-15 11:30:00.5+00' },
        { contactId: 'c2', name: 'Pisos Modelo', createdAt: '2026-09-15 08:00:00+00' },
      ],
    ]
    const out = await findRecentDuplicateContacts('acc', ['c1', 'c2', 'c3', 'c1'], {
      bodyText: 'Feliz dia do cliente!',
      mediaFilenames: [],
    })
    expect(h.selectCalls).toBe(2)
    expect(out).toEqual([
      { contactId: 'c1', name: 'Flash Baterias', lastSentAt: '2026-09-15T11:30:00.500Z', reason: 'same_text' },
      { contactId: 'c2', name: 'Pisos Modelo', lastSentAt: '2026-09-15T10:00:00.000Z', reason: 'same_text' },
    ])
  })

  it('só mídia: casa pelo conjunto de nomes de arquivo e não olha mensagens', async () => {
    h.results = [
      [
        // mesma imagem subida de novo (URL nova, nome igual) → repetido
        {
          contactId: 'c1',
          name: 'Vidro e Cia',
          status: 'sent',
          sentAt: '2026-09-15 09:00:00+00',
          media: [{ url: 'https://s/novo-uuid.jpg', type: 'image', filename: 'Dia do Cliente.jpg' }],
          mediaUrl: null,
          mediaFilename: null,
        },
        // outra imagem → não é o mesmo conteúdo
        {
          contactId: 'c2',
          name: 'Outra',
          status: 'sent',
          sentAt: '2026-09-15 09:00:00+00',
          media: [{ url: 'https://s/x.jpg', type: 'image', filename: 'promo.jpg' }],
          mediaUrl: null,
          mediaFilename: null,
        },
        // mesma imagem + outra a mais → conjunto diferente
        {
          contactId: 'c3',
          name: 'Mais uma',
          status: 'sent',
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
          status: 'read',
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
    expect(out[1]).toEqual({ contactId: 'c4', name: null, lastSentAt: '2026-09-15T07:00:00.000Z', reason: 'same_files' })
  })

  it('texto: mesma legenda com a mesma arte (ou nomes genéricos) é repetido; o motivo é o texto/legenda', async () => {
    h.results = [
      [
        { contactId: 'c1', name: 'A', sentAt: '2026-09-15 09:00:00+00', media: [{ url: 'https://s/x.jpg', filename: 'dia.jpg' }], mediaUrl: null, mediaFilename: null },
        { contactId: 'c2', name: 'B', sentAt: '2026-09-15 09:00:00+00', media: [{ url: 'https://s/y.jpg', filename: 'image.png' }], mediaUrl: null, mediaFilename: null },
      ],
    ]
    const out = await findRecentDuplicateContacts('acc', ['c1', 'c2'], {
      bodyText: 'Oi',
      mediaFilenames: ['dia.jpg', 'image.png'],
    })
    expect(out.map((d) => [d.contactId, d.reason])).toEqual([['c1', 'same_text']])
  })

  // Conferência 15/09: panfleto diário com a mesma legenda e imagem nova.
  it('texto igual com anexo claramente outro NÃO é repetido (e não consulta mensagens à mão)', async () => {
    h.results = [
      [
        { contactId: 'c1', name: 'A', sentAt: '2026-09-15 09:00:00+00', media: [{ url: 'https://s/x.jpg', filename: 'oferta-segunda.jpg' }], mediaUrl: null, mediaFilename: null },
      ],
      [{ contactId: 'c1', name: 'A', createdAt: '2026-09-15 09:00:00+00' }],
    ]
    const out = await findRecentDuplicateContacts('acc', ['c1'], {
      bodyText: 'Confira as ofertas de hoje na GoLink!',
      mediaFilenames: ['oferta-terca.jpg'],
    })
    expect(out).toEqual([])
    expect(h.selectCalls).toBe(1)
  })

  // Conferência 15/09: quem só está na fila de outro disparo não sai (se o
  // outro fosse cancelado, nunca receberia) — o worker garante um envio só.
  it('só conta quem SAIU, na mesma família de canal', async () => {
    h.results = [[], []]
    await findRecentDuplicateContacts('acc', ['c1'], {
      bodyText: 'Nós da GoLink desejamos um feliz dia do cliente!',
      mediaFilenames: [],
    })
    const q = renderWhere(0)
    expect(q.params).toContain('sent')
    expect(q.params).not.toContain('pending')
    expect(q.sql).not.toContain('"broadcasts"."status"')
    // WhatsApp não compara com disparo de e-mail
    expect(q.sql).toContain('("channels"."provider" IS NULL OR "channels"."provider" NOT IN ($')
    expect(q.params).toContain('gmail')
    // quem tem mensagem própria ({{mensagem}}) não entra na conta
    expect(q.sql).toContain('"broadcast_recipients"."vars" IS NULL')
  })

  // Revisão 15/09 (D): "Segue em anexo." com assuntos diferentes pulava todo mundo.
  it('e-mail com assunto: o assunto também tem que bater e as mensagens à mão ficam fora', async () => {
    h.results = [[], [{ contactId: 'c1', name: 'A', createdAt: '2026-09-15 11:30:00+00' }]]
    const out = await findRecentDuplicateContacts('acc', ['c1'], {
      bodyText: 'Segue em anexo o boleto de setembro, obrigado!',
      mediaFilenames: [],
      subject: 'Boleto de setembro',
    })
    // sem registro de disparo com o mesmo assunto → ninguém pula, mesmo com
    // mensagem de texto igual (a mensagem não guarda o assunto)
    expect(out).toEqual([])
    expect(h.selectCalls).toBe(1)
    const q = renderWhere(0)
    expect(q.sql).toContain('"broadcasts"."subject"')
    expect(q.params).toContain('Boleto de setembro')
    expect(q.sql).toContain('"channels"."provider" IN ($')
  })

  // Conferência 15/09: assunto que sobrou do formulário num disparo de WhatsApp.
  it('WhatsApp com assunto sobrando: assunto ignorado, mensagens à mão consultadas', async () => {
    h.results = [[], []]
    await findRecentDuplicateContacts('acc', ['c1'], {
      bodyText: 'Nós da GoLink desejamos um feliz dia do cliente!',
      mediaFilenames: [],
      subject: 'Assunto digitado antes de trocar de canal',
      emailChannel: false,
    })
    expect(renderWhere(0).sql).not.toContain('"broadcasts"."subject"')
    expect(h.selectCalls).toBe(2)
  })

  it('sem assunto (WhatsApp): não filtra por assunto', async () => {
    h.results = [[], []]
    await findRecentDuplicateContacts('acc', ['c1'], {
      bodyText: 'Nós da GoLink desejamos um feliz dia do cliente!',
      mediaFilenames: [],
    })
    expect(renderWhere(0).sql).not.toContain('"broadcasts"."subject"')
  })

  // Revisão 15/09 (D): um "Bom dia!" digitado à mão não pode barrar campanha.
  it('"Bom dia!" à mão não barra: texto curto não consulta mensagens', async () => {
    h.results = [[], [{ contactId: 'c1', name: 'A', createdAt: '2026-09-15 08:00:00+00' }]]
    const out = await findRecentDuplicateContacts('acc', ['c1'], { bodyText: 'Bom dia!', mediaFilenames: [] })
    expect(out).toEqual([])
    expect(h.selectCalls).toBe(1)
  })

  it('texto com 20+ caracteres consulta as mensagens à mão', async () => {
    h.results = [[], [{ contactId: 'c1', name: 'A', createdAt: '2026-09-15 08:00:00+00' }]]
    const out = await findRecentDuplicateContacts('acc', ['c1'], {
      bodyText: 'Bom dia! Promoção de hoje',
      mediaFilenames: [],
    })
    expect(h.selectCalls).toBe(2)
    expect(out.map((d) => d.reason)).toEqual(['same_text'])
  })

  // Revisão 15/09 (E): anexo sem texto comparava só pelo nome, e "image.png"
  // de outra campanha barrava.
  it('só anexos com nome genérico: não pula ninguém e nem consulta', async () => {
    h.results = [
      [
        { contactId: 'c1', name: 'A', status: 'sent', sentAt: '2026-09-15 09:00:00+00', media: [{ url: 'https://s/1.png', filename: 'image.png' }], mediaUrl: null, mediaFilename: null },
      ],
    ]
    const out = await findRecentDuplicateContacts('acc', ['c1'], {
      bodyText: null,
      mediaFilenames: ['image.png', 'IMG_1234.jpg'],
    })
    expect(out).toEqual([])
    expect(h.selectCalls).toBe(0)
  })

  it('nome genérico junto com um que identifica: compara pelo que identifica', async () => {
    h.results = [
      [
        // mesma arte + "image.png" (outro upload) → repetido
        { contactId: 'c1', name: 'A', status: 'sent', sentAt: '2026-09-15 09:00:00+00', media: [{ url: 'https://s/1.jpg', filename: 'Dia do Cliente.jpg' }, { url: 'https://s/2.png', filename: 'image.png' }], mediaUrl: null, mediaFilename: null },
        // só "image.png" em comum → não é o mesmo conteúdo
        { contactId: 'c2', name: 'B', status: 'sent', sentAt: '2026-09-15 09:00:00+00', media: [{ url: 'https://s/3.jpg', filename: 'promo.jpg' }, { url: 'https://s/4.png', filename: 'image.png' }], mediaUrl: null, mediaFilename: null },
      ],
    ]
    const out = await findRecentDuplicateContacts('acc', ['c1', 'c2'], {
      bodyText: null,
      mediaFilenames: ['dia do cliente.jpg', 'image.png'],
    })
    expect(out.map((d) => [d.contactId, d.reason])).toEqual([['c1', 'same_files']])
  })
})

// Revisão 15/09 (B): conferência na hora do envio (worker).
describe('contactAlreadyReceivedElsewhere', () => {
  const textInput = {
    accountId: 'acc',
    broadcastId: 'b-pausado',
    contactId: 'c1',
    messageKind: 'text',
    bodyText: 'Nós da GoLink desejamos um feliz dia do cliente!',
    subject: null,
    media: null,
    mediaUrl: null,
    mediaFilename: null,
    templateName: null,
    templateLanguage: 'en_US',
  }

  it('texto: outro disparo mandou o mesmo texto → true (uma consulta)', async () => {
    h.results = [[{ media: null, mediaUrl: null, mediaFilename: null }]]
    expect(await contactAlreadyReceivedElsewhere(textInput)).toBe(true)
    expect(h.selectCalls).toBe(1)
    expect(h.limits).toEqual([50])
    const q = renderWhere(0)
    // o próprio disparo não conta; só o que saiu
    expect(q.sql).toContain('"broadcasts"."id" <> $')
    expect(q.params).toContain('b-pausado')
    expect(q.params).toContain('sent')
    expect(q.params).not.toContain('pending')
  })

  it('texto: nada encontrado → false', async () => {
    h.results = [[]]
    expect(await contactAlreadyReceivedElsewhere(textInput)).toBe(false)
  })

  it('texto igual com anexo claramente outro → false; mesma família de canal', async () => {
    h.results = [[{ media: [{ url: 'https://s/1.jpg', filename: 'oferta-segunda.jpg' }], mediaUrl: null, mediaFilename: null }]]
    expect(
      await contactAlreadyReceivedElsewhere({
        ...textInput,
        media: [{ url: 'https://s/2.jpg', type: 'image', filename: 'oferta-terca.jpg' }],
      }),
    ).toBe(false)
    expect(renderWhere(0).sql).toContain('"channels"."provider" NOT IN ($')
  })

  it('só anexos genéricos → false sem consultar', async () => {
    expect(
      await contactAlreadyReceivedElsewhere({
        ...textInput,
        bodyText: null,
        media: [{ url: 'https://s/1.png', type: 'image', filename: 'image.png' }],
      }),
    ).toBe(false)
    expect(h.selectCalls).toBe(0)
  })

  it('só anexos: compara o conjunto de nomes', async () => {
    const input = {
      ...textInput,
      bodyText: '  ',
      media: [{ url: 'https://s/novo.jpg', type: 'image', filename: 'Dia do Cliente.jpg' }],
    }
    h.results = [[{ media: [{ url: 'https://s/outro.jpg', filename: 'promo.jpg' }], mediaUrl: null, mediaFilename: null }]]
    expect(await contactAlreadyReceivedElsewhere(input)).toBe(false)
    h.selectCalls = 0
    h.results = [[{ media: null, mediaUrl: 'https://s/velho.jpg', mediaFilename: 'dia do cliente.JPG' }]]
    expect(await contactAlreadyReceivedElsewhere(input)).toBe(true)
  })

  it('template: só com os mesmos valores', async () => {
    const input = {
      ...textInput,
      messageKind: 'template',
      bodyText: null,
      templateName: 'dia_do_cliente',
      templateLanguage: 'pt_BR',
      params: ['Flash Baterias'],
      messageParams: { headerMediaUrl: 'https://s/novo.jpg' },
    }
    h.results = [[{ params: ['Pisos Modelo'], messageParams: null }]]
    expect(await contactAlreadyReceivedElsewhere(input)).toBe(false)
    const q = renderWhere(0)
    expect(q.params).toContain('dia_do_cliente')
    expect(q.params).toContain('pt_BR')

    h.selectCalls = 0
    h.results = [[{ params: ['Flash Baterias'], messageParams: { headerMediaUrl: 'https://s/velho.jpg' } }]]
    expect(await contactAlreadyReceivedElsewhere(input)).toBe(true)
  })

  it('sem contato → false sem consultar', async () => {
    expect(await contactAlreadyReceivedElsewhere({ ...textInput, contactId: '' })).toBe(false)
    expect(h.selectCalls).toBe(0)
  })
})
