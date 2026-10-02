import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

// 02/10 — a FILA da confirmação ao agendar. Banco falso: cada SELECT consome a
// próxima resposta de `results` (um Error ali = aquele SELECT falha); cada
// db.execute (os UPDATEs da fila) consome a próxima de `execs` e fica
// registrado para conferir o SQL e os parâmetros. O envio e a busca da
// conversa são espiões — o envio de verdade é testado em
// confirmacao-envio.test.ts.
//
// Dados fictícios (LGPD): nenhum paciente de verdade aqui.

const h = vi.hoisted(() => {
  const state = {
    results: [] as unknown[],
    execs: [] as unknown[],
    inserts: [] as Record<string, unknown>[],
    settings: { bookingConfirmation: true, businessTimezone: 'America/Sao_Paulo' } as Record<string, unknown>,
  }
  const chain = () => {
    let promise: Promise<unknown> | null = null
    const settle = () => {
      if (!promise) {
        const next = state.results.shift()
        promise = next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? [])
      }
      return promise
    }
    const self: unknown = new Proxy(
      {},
      {
        get(_t, prop: string | symbol) {
          if (prop === 'then' || prop === 'catch' || prop === 'finally') {
            const p = settle()
            return (p as unknown as Record<string, (...a: unknown[]) => unknown>)[prop as string].bind(p)
          }
          return () => self
        },
      },
    )
    return self
  }
  return {
    state,
    db: {
      select: () => chain(),
      execute: vi.fn<(q: unknown) => Promise<{ rows: unknown[] }>>(async () => {
        const next = state.execs.shift()
        if (next instanceof Error) throw next
        return (next as { rows: unknown[] } | undefined) ?? { rows: [] }
      }),
      insert: () => ({
        values: async (v: Record<string, unknown>) => {
          state.inserts.push(v)
        },
      }),
    },
    // Desde a revisão de 02/10 o envio devolve o resultado E o retrato que usou.
    enviar: vi.fn<(args: Record<string, unknown>) => Promise<unknown>>(async () => ({ resultado: 'enviada', retrato: null })),
    conversa: vi.fn<(accountId: string, contactId: string, pedida: string | null) => Promise<unknown>>(async () => ({
      id: 'cv-recente',
      provider: 'waha',
    })),
  }
})

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  return { ...actual, db: h.db }
})
vi.mock('@/lib/settings/account-settings', () => ({
  getAccountSettings: async () => h.state.settings,
}))
vi.mock('./confirmacao-envio', () => ({
  enviarConfirmacaoDoAgendamento: h.enviar,
  conversaDoPaciente: h.conversa,
}))

import {
  ESPERA_PARA_FECHAR_DE_NOVO_MS,
  agendarConfirmacao,
  conferirEdicaoSemCaixa,
  descartarConfirmacaoPendente,
  processarConfirmacoesVencidas,
  sqlFecharItem,
  sqlMarcarEnviando,
  sqlPegarVencidas,
} from './confirmacao-fila'
import { MOTIVO_INCERTO, isConfirmacaoEnviando, isDesfechoDaConfirmacao } from './confirmacao-agendamento'

const dialect = new PgDialect()
const plano = (s: string) => s.replace(/\s+/g, ' ').trim()
/** O i-ésimo db.execute: texto (espaços normalizados) e parâmetros. */
const exec = (i: number) => {
  const q = dialect.sqlToQuery(h.db.execute.mock.calls[i]?.[0] as SQL)
  return { sql: plano(q.sql), params: q.params, cru: q.sql }
}

const AGORA = new Date('2026-10-02T13:05:00.000Z')
const CV = '0b5e2a8e-1111-4222-8333-944455556666'
// O compromisso como está gravado DEPOIS do salvar (quinta 08/10, 14h em SP).
const LINHA = {
  status: 'confirmed',
  startsAt: '2026-10-08 17:00:00+00',
  endsAt: '2026-10-08 18:00:00+00',
  allDay: false,
  calendarId: 'cal-a',
  contactId: 'c-1',
  calendarName: 'Dra. Fulana Exemplo',
  isGroup: false,
  optedOut: false,
  dueAt: null as string | null,
  known: null as unknown,
}
const ANTES = { startsAt: '2026-10-08 17:00:00+00', calendarId: 'cal-a', contactId: 'c-1' }
const NA_FILA = { rows: [{ due_at: '2026-10-02 13:08:00.123+00' }] }

const agendar = (extra: Partial<Parameters<typeof agendarConfirmacao>[0]> = {}) =>
  agendarConfirmacao({ accountId: 'acc-1', eventId: 'ev-1', antes: null, conversationId: CV, agora: AGORA, ...extra })

beforeEach(() => {
  h.state.results = []
  h.state.execs = []
  h.state.inserts = []
  h.state.settings = { bookingConfirmation: true, businessTimezone: 'America/Sao_Paulo' }
  h.db.execute.mockClear()
  h.enviar.mockReset()
  h.enviar.mockImplementation(async () => ({ resultado: 'enviada', retrato: null }))
  h.conversa.mockReset()
  h.conversa.mockImplementation(async () => ({ id: 'cv-recente', provider: 'waha' }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('o salvar põe na fila (agendarConfirmacao)', () => {
  it('compromisso novo: sai 3 min depois, pela conversa de onde veio; o paciente ainda não sabe de nada', async () => {
    h.state.results.push([LINHA])
    h.state.execs.push(NA_FILA)

    const r = await agendar()

    expect(r).toEqual({ agendada: '2026-10-02T13:08:00.123Z' })
    expect(h.db.execute).toHaveBeenCalledTimes(1)
    const q = exec(0)
    expect(q.sql).toContain("SET confirmation_due_at = now() + $1::int * interval '1 millisecond'")
    expect(q.sql).toContain('confirmation_conversation_id = COALESCE($2::uuid, confirmation_conversation_id)')
    // Base só nasce numa EDIÇÃO sem nada pendente e sem base; compromisso novo: NULL.
    expect(q.sql).toContain(
      'confirmation_known = CASE WHEN confirmation_due_at IS NULL AND confirmation_known IS NULL THEN $3::jsonb ELSE confirmation_known END',
    )
    // O desfecho antigo não vale mais: o que vale é o pendente novo — menos o
    // marcador 'enviando' de um worker que morreu no meio (revisão de 02/10):
    // é ele que impede a próxima passada de mandar de novo.
    expect(q.sql).toContain(
      "confirmation_result = CASE WHEN confirmation_result->>'status' = 'enviando' THEN confirmation_result ELSE NULL END",
    )
    expect(q.params).toEqual([180_000, CV, null, 'ev-1', 'acc-1'])
    expect(q.cru).not.toContain('--')
    // Nada sai no salvar.
    expect(h.enviar).not.toHaveBeenCalled()
  })

  it('opção desligada na conta: diz na hora, tira da fila e nem lê o compromisso', async () => {
    h.state.settings = { bookingConfirmation: false }
    h.state.results.push([LINHA])

    const r = await agendar()

    expect(r).toEqual({ naoEnviada: 'a confirmação ao agendar está desligada nesta conta' })
    expect(exec(0).sql).toContain('SET confirmation_due_at = NULL, confirmation_conversation_id = NULL')
    // O SELECT do compromisso nem aconteceu: a resposta dele continua na fila.
    expect(h.state.results).toHaveLength(1)
  })

  it('"não perturbe": diz na hora (o mesmo texto do envio) e não deixa nada na fila', async () => {
    h.state.results.push([{ ...LINHA, optedOut: true }])

    const r = await agendar()

    expect(r).toEqual({ naoEnviada: 'o paciente pediu para não receber mensagens (não perturbe)' })
    const q = exec(0)
    expect(q.sql).toContain('SET confirmation_due_at = NULL')
    expect(JSON.parse(q.params[0] as string)).toMatchObject({ status: 'naoEnviada' })
  })

  it('tirar da fila falhou: o modal ainda recebe o motivo de verdade', async () => {
    h.state.results.push([{ ...LINHA, optedOut: true }])
    h.state.execs.push(new Error('connection terminated'))

    expect(await agendar()).toEqual({ naoEnviada: 'o paciente pediu para não receber mensagens (não perturbe)' })
  })

  it('horário que já passou: diz na hora', async () => {
    h.state.results.push([LINHA])

    const r = await agendar({ agora: new Date('2026-10-09T12:00:00.000Z') })

    expect(r).toEqual({ naoEnviada: 'o horário do compromisso já passou' })
  })

  it('edição que mudou o horário, sem nada pendente e sem base: fila, e o "antes" vira o que o paciente sabia', async () => {
    h.state.results.push([{ ...LINHA, startsAt: '2026-10-09 17:00:00+00', endsAt: '2026-10-09 18:00:00+00' }])
    h.state.execs.push(NA_FILA)

    const r = await agendar({ antes: ANTES, conversationId: null })

    expect(r).toEqual({ agendada: '2026-10-02T13:08:00.123Z' })
    expect(exec(0).params).toEqual([180_000, null, JSON.stringify(ANTES), 'ev-1', 'acc-1'])
  })

  it('edição que não mudou nada para o paciente (só o título): nada vai para a fila', async () => {
    h.state.results.push([LINHA])

    expect(await agendar({ antes: ANTES })).toBeNull()
    expect(h.db.execute).not.toHaveBeenCalled()
  })

  it('marcação ainda na fila: salvar de novo EMPURRA a saída (sai só a última versão)', async () => {
    // Criou às 18h, a confirmação ficou na fila; a recepção corrigiu a hora.
    h.state.results.push([{ ...LINHA, dueAt: '2026-10-02 13:06:00+00', known: null }])
    h.state.execs.push(NA_FILA)

    const r = await agendar({ antes: ANTES })

    expect(r).toEqual({ agendada: '2026-10-02T13:08:00.123Z' })
    expect(exec(0).sql).toContain('SET confirmation_due_at = now() +')
  })

  it('o paciente já sabe deste horário (moveu e voltou): nada vai para a fila', async () => {
    h.state.results.push([{ ...LINHA, known: { startsAt: '2026-10-08T17:00:00+00:00', calendarId: 'cal-a', contactId: 'c-1' } }])

    // O "antes" deste salvar era outro horário; o que vale é o que o paciente sabe.
    const r = await agendar({ antes: { ...ANTES, startsAt: '2026-10-09 17:00:00+00' } })

    expect(r).toBeNull()
    expect(h.db.execute).not.toHaveBeenCalled()
  })

  it('trocou para a agenda de OUTRO profissional no mesmo horário: fila (o paciente vai saber com quem é)', async () => {
    h.state.results.push(
      [{ ...LINHA, calendarId: 'cal-b', calendarName: 'Dr. Beltrano Teste' }],
      [{ name: 'Dra. Fulana Exemplo' }],
    )
    h.state.execs.push(NA_FILA)

    expect(await agendar({ antes: ANTES })).toEqual({ agendada: '2026-10-02T13:08:00.123Z' })
  })

  it('trocou para uma agenda genérica: nada a dizer ao paciente', async () => {
    h.state.results.push([{ ...LINHA, calendarId: 'cal-b', calendarName: 'Minha agenda' }], [{ name: 'Dra. Fulana Exemplo' }])

    expect(await agendar({ antes: ANTES })).toBeNull()
  })

  it('conversa que não é um id (link adulterado): ignorada, sem derrubar o UPDATE', async () => {
    h.state.results.push([LINHA])
    h.state.execs.push(NA_FILA)

    await agendar({ conversationId: "abc'; drop" })

    expect(exec(0).params[1]).toBeNull()
  })

  it('banco fora do ar: não lança, e o modal diz que não deu', async () => {
    h.state.results.push(new Error('connection terminated'))

    expect(await agendar()).toEqual({ naoEnviada: 'não foi possível agendar a confirmação agora' })
  })
})

describe('edição salva SEM a caixa na tela (conferirEdicaoSemCaixa) — revisão de 02/10', () => {
  // O cenário da revisão: salvou 10h→11h (fila), o worker mandou "remarcada
  // para 11h" (known = 11h), a grade velha ainda dizia que o paciente sabia
  // das 10h, e a recepção voltou para 10h sem a caixa aparecer.
  const ONZE = '2026-10-08 18:00:00+00'
  const DEZ_GRAVADO = { ...LINHA, startsAt: LINHA.startsAt, known: { startsAt: ONZE, calendarId: 'cal-a', contactId: 'c-1' } }
  const ANTES_ONZE = { ...ANTES, startsAt: ONZE }
  const conferir = (extra: Partial<Parameters<typeof conferirEdicaoSemCaixa>[0]> = {}) =>
    conferirEdicaoSemCaixa({ accountId: 'acc-1', eventId: 'ev-1', antes: ANTES_ONZE, agora: AGORA, ...extra })

  it('o paciente sabe de OUTRO horário e nada está pendente: põe na fila (o padrão da caixa) e o aviso diz por quê', async () => {
    // 1ª leitura: a conferência; 2ª: a do agendarConfirmacao.
    h.state.results.push([DEZ_GRAVADO], [DEZ_GRAVADO])
    h.state.execs.push(NA_FILA)

    const r = await conferir()

    expect(r).toEqual({ agendada: '2026-10-02T13:08:00.123Z', semCaixa: true })
    expect(h.db.execute).toHaveBeenCalledTimes(1)
    expect(exec(0).sql).toContain("SET confirmation_due_at = now() + $1::int * interval '1 millisecond'")
    // A base gravada (11h) fica: o CASE só usa o "antes" quando não há base.
    expect(exec(0).params).toEqual([180_000, null, JSON.stringify(ANTES_ONZE), 'ev-1', 'acc-1'])
    expect(h.enviar).not.toHaveBeenCalled()
  })

  it('compromisso antigo sem base e só o título mudou: nada (o paciente não precisa saber)', async () => {
    h.state.results.push([LINHA])

    expect(await conferir({ antes: ANTES })).toBeNull()
    expect(h.db.execute).not.toHaveBeenCalled()
  })

  it('o paciente já sabe deste horário (moveu e voltou): nada', async () => {
    h.state.results.push([{ ...LINHA, known: { startsAt: '2026-10-08T17:00:00+00:00', calendarId: 'cal-a', contactId: 'c-1' } }])

    expect(await conferir()).toBeNull()
    expect(h.db.execute).not.toHaveBeenCalled()
  })

  it('já há uma na fila: não mexe — o worker manda o estado final, comparado com a base', async () => {
    h.state.results.push([{ ...DEZ_GRAVADO, dueAt: '2026-10-02 13:06:00+00' }])

    expect(await conferir()).toBeNull()
    expect(h.db.execute).not.toHaveBeenCalled()
  })

  it('"não perturbe": nada, e NÃO grava "não enviada" (ninguém pediu a confirmação)', async () => {
    h.state.results.push([{ ...DEZ_GRAVADO, optedOut: true }])

    expect(await conferir()).toBeNull()
    expect(h.db.execute).not.toHaveBeenCalled()
  })

  it('opção desligada na conta: nada, e nem lê o compromisso', async () => {
    h.state.settings = { bookingConfirmation: false }
    h.state.results.push([DEZ_GRAVADO])

    expect(await conferir()).toBeNull()
    expect(h.state.results).toHaveLength(1)
  })

  it('banco fora do ar: não lança, e o aviso não cala', async () => {
    h.state.results.push(new Error('connection terminated'))

    expect(await conferir()).toEqual({
      naoEnviada: 'não deu para conferir se o paciente precisa ser avisado desta mudança',
    })
  })
})

describe('caixa desmarcada na tela (descartarConfirmacaoPendente)', () => {
  it('havia uma na fila: tira, grava o estado atual como base e avisa', async () => {
    h.state.execs.push({ rows: [{ havia: true, saindo: false }] })

    const r = await descartarConfirmacaoPendente({ accountId: 'acc-1', eventId: 'ev-1', agora: AGORA })

    expect(r).toEqual({ descartada: true })
    const q = exec(0)
    // A base passa a ser o compromisso como ficou: editar só o título depois
    // não traz de volta a caixa com a mensagem que a recepção recusou.
    expect(q.sql).toContain(
      "ELSE jsonb_build_object('startsAt', u.starts_at, 'calendarId', u.calendar_id, 'contactId', u.contact_id)",
    )
    expect(q.sql).toContain('WHEN antes.confirmation_due_at IS NOT NULL THEN $4::jsonb ELSE u.confirmation_result END')
    expect(q.sql).toContain('confirmation_due_at = CASE WHEN antes.saindo THEN u.confirmation_due_at ELSE NULL END')
    expect(q.sql).toContain(
      'confirmation_conversation_id = CASE WHEN antes.saindo THEN u.confirmation_conversation_id ELSE NULL END',
    )
    expect(q.params.slice(0, 3)).toEqual([180_000, 'ev-1', 'acc-1'])
    expect(JSON.parse(q.params[3] as string)).toMatchObject({ status: 'descartada' })
    expect(q.cru).not.toContain('--')
  })

  it('o worker JÁ está enviando (lease além do atraso da fila): não mexe em nada e manda conferir a conversa', async () => {
    h.state.execs.push({ rows: [{ havia: true, saindo: true }] })

    const r = await descartarConfirmacaoPendente({ accountId: 'acc-1', eventId: 'ev-1', agora: AGORA })

    expect(r).toEqual({ incerta: 'a confirmação já estava saindo quando a caixa foi desmarcada; confira a conversa' })
    const q = exec(0)
    // "Saindo" = vencimento além de agora + 3 min (só o lease, de 10 min, passa disso).
    expect(q.sql).toContain(
      "COALESCE(confirmation_due_at > now() + $1::int * interval '1 millisecond', false) AS saindo",
    )
    // Cada coluna fica como está quando saindo — inclusive a base, que o
    // fechamento do worker vai gravar com o que a mensagem disse.
    expect(q.sql).toContain('confirmation_known = CASE WHEN antes.saindo THEN u.confirmation_known')
    expect(q.sql).toContain('confirmation_result = CASE WHEN antes.saindo THEN u.confirmation_result')
  })

  it('não havia nada na fila: nada a dizer', async () => {
    h.state.execs.push({ rows: [{ havia: false, saindo: false }] })

    expect(await descartarConfirmacaoPendente({ accountId: 'acc-1', eventId: 'ev-1' })).toBeNull()
  })

  it('banco fora do ar: não lança — e não diz "não enviada", porque ela ainda pode sair', async () => {
    h.state.execs.push(new Error('connection terminated'))

    expect(await descartarConfirmacaoPendente({ accountId: 'acc-1', eventId: 'ev-1' })).toEqual({
      incerta: 'não deu para cancelar a confirmação que estava na fila: ela ainda pode sair; confira a conversa',
    })
  })
})

describe('o marcador "enviando" não é desfecho para a tela', () => {
  it('isDesfechoDaConfirmacao recusa; isConfirmacaoEnviando reconhece', () => {
    const m = { status: 'enviando', at: AGORA.toISOString() }
    expect(isDesfechoDaConfirmacao(m)).toBe(false)
    expect(isConfirmacaoEnviando(m)).toBe(true)
    expect(isConfirmacaoEnviando({ status: 'enviada', at: AGORA.toISOString() })).toBe(false)
    expect(isConfirmacaoEnviando(null)).toBe(false)
  })
})

describe('o worker: SQL da fila', () => {
  it('pega as vencidas com lease atômico (outro tick pula as travadas)', () => {
    const q = dialect.sqlToQuery(sqlPegarVencidas())
    const s = plano(q.sql)
    expect(s).toContain("SET confirmation_due_at = now() + interval '10 minutes'")
    expect(s).toContain('WHERE e.confirmation_due_at IS NOT NULL AND e.confirmation_due_at <= now()')
    expect(s).toContain('ORDER BY e.confirmation_due_at, e.id LIMIT $1 FOR UPDATE SKIP LOCKED')
    // O lease volta em texto: o fim compara com ele exatamente, sem passar pelo Date do JS.
    expect(s).toContain('u.confirmation_due_at::text AS lease')
    expect(q.params).toEqual([20])
    expect(q.sql).not.toContain('--')
  })

  it('fecha com compare-and-swap: só limpa o pendente se o vencimento ainda é o do lease', () => {
    const q = dialect.sqlToQuery(
      sqlFecharItem({
        id: 'ev-1',
        accountId: 'acc-1',
        lease: '2026-10-02 13:18:00.123456+00',
        desfecho: { status: 'enviada', at: AGORA.toISOString() },
        novoConhecido: null,
      }),
    )
    const s = plano(q.sql)
    expect(s).toContain('confirmation_known = COALESCE($1::jsonb, confirmation_known)')
    expect(s).toContain('confirmation_result = $2::jsonb')
    expect(s).toContain('CASE WHEN confirmation_due_at = $3::timestamptz THEN NULL ELSE confirmation_conversation_id END')
    expect(s).toContain('CASE WHEN confirmation_due_at = $4::timestamptz THEN NULL ELSE confirmation_due_at END')
    expect(q.params).toEqual([
      null,
      JSON.stringify({ status: 'enviada', at: AGORA.toISOString() }),
      '2026-10-02 13:18:00.123456+00',
      '2026-10-02 13:18:00.123456+00',
      'ev-1',
      'acc-1',
    ])
    expect(q.sql).not.toContain('--')
  })

  it('o marcador "enviando" só entra se o vencimento AINDA é o do lease (revisão de 02/10)', () => {
    const marcador = { status: 'enviando' as const, at: AGORA.toISOString() }
    const q = dialect.sqlToQuery(
      sqlMarcarEnviando({ id: 'ev-1', accountId: 'acc-1', lease: '2026-10-02 13:18:00.123456+00', marcador }),
    )
    const s = plano(q.sql)
    expect(s).toBe(
      'UPDATE calendar_events SET confirmation_result = $1::jsonb WHERE id = $2 AND account_id = $3 AND confirmation_due_at = $4::timestamptz RETURNING id',
    )
    expect(q.params).toEqual([JSON.stringify(marcador), 'ev-1', 'acc-1', '2026-10-02 13:18:00.123456+00'])
    expect(q.sql).not.toContain('--')
  })
})

describe('o worker: cada confirmação vencida (processarConfirmacoesVencidas)', () => {
  const LEASE = '2026-10-02 13:18:00.123456+00'
  const ITEM = { id: 'ev-1', account_id: 'acc-1', lease: LEASE, conversation_id: 'cv-1' }
  /** O marcador 'enviando' pegou (o vencimento ainda era o do lease). */
  const MARCOU = { rows: [{ id: 'ev-1' }] }
  // O estado FINAL (agenda do Dr., quinta 14h).
  const FINAL = {
    status: 'confirmed',
    startsAt: '2026-10-08 17:00:00+00',
    allDay: false,
    calendarId: 'cal-b',
    contactId: 'c-1',
    calendarName: 'Dr. Beltrano Teste',
    known: null as unknown,
    result: null as unknown,
  }
  const RETRATO = { startsAt: FINAL.startsAt, calendarId: 'cal-b', contactId: 'c-1' }
  /** O envio devolve o resultado e o retrato da leitura DELE (revisão de 02/10). */
  const devolve = (resultado: unknown, retrato: unknown = RETRATO) => async () => ({ resultado, retrato })
  /** O UPDATE que fecha o item (é o único com o COALESCE da base). */
  const fechamento = () => {
    const i = h.db.execute.mock.calls.findIndex((c) =>
      dialect.sqlToQuery(c[0] as SQL).sql.includes('confirmation_known = COALESCE('),
    )
    const q = exec(i)
    return {
      conhecido: q.params[0] === null ? null : JSON.parse(q.params[0] as string),
      desfecho: JSON.parse(q.params[1] as string),
      lease: q.params[2],
    }
  }
  const marcacoes = () =>
    h.db.execute.mock.calls.filter((c) => dialect.sqlToQuery(c[0] as SQL).sql.includes("RETURNING id"))

  beforeEach(() => {
    h.enviar.mockImplementation(devolve('enviada'))
  })

  it('nada vencido: um UPDATE só, nada mais', async () => {
    const r = await processarConfirmacoesVencidas()

    expect(r).toEqual({ lidas: 0, enviadas: 0, naoEnviadas: 0, erros: 0 })
    expect(h.db.execute).toHaveBeenCalledTimes(1)
    expect(h.enviar).not.toHaveBeenCalled()
  })

  it('sem base: marca "enviando" ANTES, manda a MARCAÇÃO pela conversa de onde veio; enviada → o paciente passa a saber do retrato do envio', async () => {
    h.state.execs.push({ rows: [ITEM] }, MARCOU)
    h.state.results.push([FINAL])

    const r = await processarConfirmacoesVencidas()

    expect(r).toEqual({ lidas: 1, enviadas: 1, naoEnviadas: 0, erros: 0 })
    expect(h.enviar).toHaveBeenCalledTimes(1)
    // O envio recebe o que o paciente sabe (nada) e decide o tipo na leitura dele.
    expect(h.enviar).toHaveBeenCalledWith({ accountId: 'acc-1', eventId: 'ev-1', conhecido: null, conversationId: 'cv-1' })
    const marca = exec(1)
    expect(marca.sql).toContain('SET confirmation_result = $1::jsonb')
    expect(JSON.parse(marca.params[0] as string)).toMatchObject({ status: 'enviando' })
    expect(marca.params[3]).toBe(LEASE)
    expect(h.db.execute.mock.invocationCallOrder[1]).toBeLessThan(h.enviar.mock.invocationCallOrder[0])
    expect(fechamento()).toMatchObject({ conhecido: RETRATO, desfecho: { status: 'enviada' }, lease: LEASE })
    expect(h.state.inserts).toEqual([])
  })

  it('a base gravada é o retrato que o ENVIO usou, não a leitura do worker (revisão de 02/10)', async () => {
    h.state.execs.push({ rows: [ITEM] }, MARCOU)
    h.state.results.push([FINAL])
    // A recepção mexeu entre a leitura do worker e a do envio: a mensagem
    // falou do horário que o envio leu — é isso que o paciente sabe.
    const doEnvio = { startsAt: '2026-10-08 18:30:00+00', calendarId: 'cal-b', contactId: 'c-1' }
    h.enviar.mockImplementationOnce(devolve('enviada', doEnvio))

    await processarConfirmacoesVencidas()

    expect(fechamento().conhecido).toEqual(doEnvio)
  })

  it('o paciente já sabia de outro horário: o envio recebe essa base (com o nome da agenda) e decide "remarcada"', async () => {
    const known = { startsAt: '2026-10-07T17:00:00+00:00', calendarId: 'cal-b', contactId: 'c-1' }
    h.state.execs.push({ rows: [ITEM] }, MARCOU)
    h.state.results.push([{ ...FINAL, known }])

    await processarConfirmacoesVencidas()

    expect(h.enviar).toHaveBeenCalledWith(
      expect.objectContaining({ conhecido: { ...known, nomeAgenda: 'Dr. Beltrano Teste' } }),
    )
  })

  it('a confirmação saiu "com a Dra." errada e a recepção trocou a agenda: o envio recebe o nome da agenda de ANTES', async () => {
    const known = { startsAt: '2026-10-08T17:00:00+00:00', calendarId: 'cal-a', contactId: 'c-1' }
    h.state.execs.push({ rows: [ITEM] }, MARCOU)
    h.state.results.push(
      [{ ...FINAL, known }],
      [{ name: 'Dra. Fulana Exemplo' }], // o nome da agenda que o paciente conhece
    )

    await processarConfirmacoesVencidas()

    expect(h.enviar).toHaveBeenCalledWith(
      expect.objectContaining({ conhecido: { ...known, nomeAgenda: 'Dra. Fulana Exemplo' } }),
    )
  })

  it('moveu e voltou antes de sair: não marca nem manda, grava "sem mudança" e a base fica como estava', async () => {
    h.state.execs.push({ rows: [ITEM] })
    h.state.results.push([{ ...FINAL, known: { startsAt: '2026-10-08T17:00:00+00:00', calendarId: 'cal-b', contactId: 'c-1' } }])

    const r = await processarConfirmacoesVencidas()

    expect(h.enviar).not.toHaveBeenCalled()
    expect(marcacoes()).toHaveLength(0)
    expect(fechamento()).toMatchObject({ conhecido: null, desfecho: { status: 'semMudanca' } })
    expect(r.enviadas).toBe(0)
  })

  it('cancelado antes de sair: descarta, sem nota (foi a própria recepção)', async () => {
    h.state.execs.push({ rows: [ITEM] })
    h.state.results.push([{ ...FINAL, status: 'cancelled' }])

    await processarConfirmacoesVencidas()

    expect(h.enviar).not.toHaveBeenCalled()
    expect(fechamento().desfecho).toMatchObject({ status: 'descartada', motivo: 'o compromisso foi cancelado' })
    expect(h.state.inserts).toEqual([])
  })

  it('a releitura do ENVIO não pede mensagem (moveu e voltou no meio): "sem mudança", sem nota nem base nova', async () => {
    h.state.execs.push({ rows: [ITEM] }, MARCOU)
    h.state.results.push([FINAL])
    h.enviar.mockImplementationOnce(devolve({ semMudanca: true }))

    const r = await processarConfirmacoesVencidas()

    expect(fechamento()).toMatchObject({ conhecido: null, desfecho: { status: 'semMudanca' } })
    expect(h.state.inserts).toEqual([])
    expect(r).toEqual({ lidas: 1, enviadas: 0, naoEnviadas: 0, erros: 0 })
  })

  it('a releitura do ENVIO achou o compromisso cancelado: "descartada", sem nota', async () => {
    h.state.execs.push({ rows: [ITEM] }, MARCOU)
    h.state.results.push([FINAL])
    h.enviar.mockImplementationOnce(devolve({ descartada: 'o compromisso foi cancelado' }))

    await processarConfirmacoesVencidas()

    expect(fechamento().desfecho).toMatchObject({ status: 'descartada', motivo: 'o compromisso foi cancelado' })
    expect(h.state.inserts).toEqual([])
  })

  it('a recepção mexeu na fila depois do lease (o marcador não pegou): não envia nem fecha — vale o que ela fez', async () => {
    h.state.execs.push({ rows: [ITEM] }, { rows: [] })
    h.state.results.push([FINAL])

    const r = await processarConfirmacoesVencidas()

    expect(h.enviar).not.toHaveBeenCalled()
    expect(h.db.execute).toHaveBeenCalledTimes(2) // pegar + marcar; nada de fechar
    expect(r).toEqual({ lidas: 1, enviadas: 0, naoEnviadas: 0, erros: 0 })
  })

  it('a tentativa anterior morreu depois de marcar "enviando": fecha como incerta, SEM reenviar, com nota e o estado final como base', async () => {
    h.state.execs.push({ rows: [ITEM] })
    h.state.results.push([{ ...FINAL, result: { status: 'enviando', at: '2026-10-02T13:05:10.000Z' } }])

    const r = await processarConfirmacoesVencidas()

    expect(h.enviar).not.toHaveBeenCalled()
    expect(marcacoes()).toHaveLength(0)
    expect(fechamento()).toMatchObject({
      conhecido: RETRATO,
      desfecho: { status: 'incerta', motivo: MOTIVO_INCERTO },
      lease: LEASE,
    })
    expect(h.state.inserts[0]?.contentText).toBe(
      '⚠️ Confirmação da consulta de quinta-feira, 08/10/2026, às 14h: não deu para confirmar se a mensagem saiu; confira a conversa antes de reenviar.',
    )
    expect(r.naoEnviadas).toBe(1)
  })

  it('não enviada: fica no compromisso E vira nota interna na conversa do paciente', async () => {
    h.state.execs.push({ rows: [ITEM] }, MARCOU)
    h.state.results.push([FINAL])
    h.enviar.mockImplementationOnce(devolve({ naoEnviada: 'nenhum WhatsApp conectado nesta conta' }))

    const r = await processarConfirmacoesVencidas()

    expect(r).toEqual({ lidas: 1, enviadas: 0, naoEnviadas: 1, erros: 0 })
    expect(fechamento()).toMatchObject({
      conhecido: null,
      desfecho: { status: 'naoEnviada', motivo: 'nenhum WhatsApp conectado nesta conta' },
    })
    expect(h.conversa).toHaveBeenCalledWith('acc-1', 'c-1', 'cv-1')
    // Igual às outras notas de sistema: 'bot' + interna. Não sai para o
    // paciente, não dispara a IA, não conta como resposta de atendente.
    expect(h.state.inserts).toEqual([
      {
        conversationId: 'cv-recente',
        senderType: 'bot',
        contentType: 'text',
        contentText:
          '⚠️ Confirmação da consulta de quinta-feira, 08/10/2026, às 14h não enviada: nenhum WhatsApp conectado nesta conta.',
        isInternal: true,
        status: 'sent',
      },
    ])
  })

  it('incerta: a nota manda conferir antes de reenviar, e vira base (pode ter chegado)', async () => {
    h.state.execs.push({ rows: [ITEM] }, MARCOU)
    h.state.results.push([FINAL])
    h.enviar.mockImplementationOnce(devolve({ incerta: MOTIVO_INCERTO }))

    await processarConfirmacoesVencidas()

    expect(h.state.inserts[0]?.contentText).toBe(
      '⚠️ Confirmação da consulta de quinta-feira, 08/10/2026, às 14h: não deu para confirmar se a mensagem saiu; confira a conversa antes de reenviar.',
    )
    expect(fechamento().conhecido).toEqual(RETRATO)
  })

  it('não enviada e o paciente sem conversa de WhatsApp: fica só no compromisso', async () => {
    h.state.execs.push({ rows: [ITEM] }, MARCOU)
    h.state.results.push([FINAL])
    h.enviar.mockImplementationOnce(devolve({ naoEnviada: 'o paciente não tem conversa de WhatsApp' }))
    h.conversa.mockImplementationOnce(async () => null)

    await processarConfirmacoesVencidas()

    expect(fechamento().desfecho).toMatchObject({ status: 'naoEnviada' })
    expect(h.state.inserts).toEqual([])
  })

  it('apagado no meio do envio ("não encontrado"): sem nota', async () => {
    h.state.execs.push({ rows: [ITEM] }, MARCOU)
    h.state.results.push([FINAL])
    h.enviar.mockImplementationOnce(devolve({ naoEnviada: 'o compromisso não foi encontrado' }, null))

    await processarConfirmacoesVencidas()

    expect(h.state.inserts).toEqual([])
  })

  it('apagado antes de o worker ler: nada a enviar nem a fechar', async () => {
    h.state.execs.push({ rows: [ITEM] })
    h.state.results.push([])

    const r = await processarConfirmacoesVencidas()

    expect(h.enviar).not.toHaveBeenCalled()
    expect(h.db.execute).toHaveBeenCalledTimes(1)
    expect(r.erros).toBe(0)
  })

  it('erro num item não derruba os outros: ele fica com o lease e volta em 10 min', async () => {
    h.state.execs.push({ rows: [ITEM, { ...ITEM, id: 'ev-2' }] }, { rows: [{ id: 'ev-2' }] })
    h.state.results.push(new Error('connection terminated'), [FINAL])

    const r = await processarConfirmacoesVencidas()

    expect(r).toEqual({ lidas: 2, enviadas: 1, naoEnviadas: 0, erros: 1 })
    expect(h.enviar).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'ev-2' }))
  })

  it('fechar falhou uma vez: espera um pouco e tenta de novo — senão o lease vence e a linha volta', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      h.state.execs.push({ rows: [ITEM] }, MARCOU, new Error('connection terminated'), { rows: [] })
      h.state.results.push([FINAL])

      const p = processarConfirmacoesVencidas()
      // A 1ª tentativa de fechar falhou e a espera foi armada. (Sem vi.waitFor:
      // com relógio falso ele adianta o relógio a cada checagem.)
      for (let i = 0; i < 1_000 && vi.getTimerCount() === 0; i++) await Promise.resolve()
      expect(vi.getTimerCount()).toBe(1)
      expect(h.db.execute).toHaveBeenCalledTimes(3)
      // Antes de a espera acabar, nada de 2ª tentativa.
      await vi.advanceTimersByTimeAsync(ESPERA_PARA_FECHAR_DE_NOVO_MS - 1)
      expect(h.db.execute).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(1)
      const r = await p

      expect(h.db.execute).toHaveBeenCalledTimes(4)
      expect(exec(3).sql).toBe(exec(2).sql)
      expect(r.enviadas).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
