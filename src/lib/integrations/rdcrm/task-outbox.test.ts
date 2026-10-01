import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

// Banco simulado sem vi.fn: no Vitest 4, mock com mockReset que devolve
// promessa rejeitada reprova o teste mesmo com a rejeição tratada.
const executed: SQL[] = []
let executeImpl: (q: SQL) => Promise<unknown> = async () => ({ rows: [] })
vi.mock('@/db', () => ({
  db: {
    execute: (q: SQL) => {
      executed.push(q)
      return executeImpl(q)
    },
  },
}))

import { RdCrmError, type RdTask } from './client'
import {
  buildRdTaskBody,
  enqueueRdTask,
  findSameRdTask,
  pushTaskToRd,
  rdTaskDateHour,
  type RdTaskPush,
} from './task-outbox'

const dialect = new PgDialect()

const PUSH: RdTaskPush = {
  rdDealId: 'rd-deal-1',
  userId: 'rd-user-1',
  kind: 'whatsapp',
  subject: 'Cadência «Pré-vendas» — toque 2 enviado (WhatsApp)',
  notes: 'Mensagem enviada pela cadência:\nOlá, tudo bem?',
  date: '2026-10-01',
  hour: '09:05',
}

describe('rdTaskDateHour', () => {
  it('data e hora no fuso da conta (UTC−3 vira o dia anterior perto da meia-noite)', () => {
    const at = new Date('2026-10-01T02:30:00Z') // 23:30 de 30/09 em SP
    expect(rdTaskDateHour(at, 'America/Sao_Paulo')).toEqual({ date: '2026-09-30', hour: '23:30' })
    expect(rdTaskDateHour(at, 'UTC')).toEqual({ date: '2026-10-01', hour: '02:30' })
  })
  it('fuso inválido ou vazio cai no de São Paulo', () => {
    const at = new Date('2026-10-01T12:00:00Z')
    expect(rdTaskDateHour(at, 'Nada/Aqui')).toEqual({ date: '2026-10-01', hour: '09:00' })
    expect(rdTaskDateHour(at, '')).toEqual({ date: '2026-10-01', hour: '09:00' })
  })
})

describe('buildRdTaskBody', () => {
  it('corpo do POST /tasks: tudo dentro de "task", concluída, sem acento', () => {
    expect(buildRdTaskBody(PUSH)).toEqual({
      task: {
        deal_id: 'rd-deal-1',
        user_ids: ['rd-user-1'],
        subject: 'Cadencia "Pre-vendas" - toque 2 enviado (WhatsApp)',
        type: 'whatsapp',
        date: '2026-10-01',
        hour: '09:05',
        notes: 'Mensagem enviada pela cadencia:\nOla, tudo bem?',
        done: true,
      },
    })
  })
  it('sem notas não manda o campo; a versão de fallback vai sem `done`', () => {
    const b = buildRdTaskBody({ ...PUSH, kind: 'email', notes: null }, { done: false })
    expect(b.task).not.toHaveProperty('notes')
    expect(b.task).not.toHaveProperty('done')
    expect(b.task.type).toBe('email')
  })
})

describe('findSameRdTask', () => {
  const lista: RdTask[] = [
    { id: 'outra', subject: 'Ligar', date: '2026-10-01', hour: '09:05', done: true },
    { id: 'igual', subject: 'Cadencia "Pre-vendas" - toque 2 enviado (WhatsApp)', date: '2026-10-01T00:00:00.000-03:00', hour: '09:05:00', done: false },
  ]
  it('acha pela combinação assunto (como foi enviado) + data + hora', () => {
    expect(findSameRdTask(lista, PUSH)?.id).toBe('igual')
  })
  it('hora ou data diferente não é a mesma tarefa', () => {
    expect(findSameRdTask(lista, { ...PUSH, hour: '09:06' })).toBeNull()
    expect(findSameRdTask(lista, { ...PUSH, date: '2026-10-02' })).toBeNull()
  })
})

describe('pushTaskToRd', () => {
  type Create = (body: unknown) => Promise<RdTask>
  function fakeApi(opts: { existing?: RdTask[]; create?: Create } = {}) {
    const defaultCreate: Create = async () => ({ id: 'novo', done: true })
    const api = {
      listDealTasks: vi.fn<(dealId: string) => Promise<RdTask[]>>(async () => opts.existing ?? []),
      createTask: vi.fn<Create>(opts.create ?? defaultCreate),
      updateTask: vi.fn<(id: string, body: unknown) => Promise<RdTask>>(async () => ({ id: 'x', done: true })),
    }
    return api
  }

  it('cria concluída e não precisa de PUT quando o RD já devolve done=true', async () => {
    const api = fakeApi()
    expect(await pushTaskToRd(api, PUSH)).toEqual({ id: 'novo', reused: false })
    expect(api.listDealTasks).toHaveBeenCalledWith('rd-deal-1')
    expect(api.createTask).toHaveBeenCalledWith(buildRdTaskBody(PUSH))
    expect(api.updateTask).not.toHaveBeenCalled()
  })

  it('dedupe: tarefa igual já no RD (POST anterior estourou o tempo) → não cria outra, só conclui', async () => {
    const api = fakeApi({
      existing: [{ _id: 'velha', subject: 'Cadencia "Pre-vendas" - toque 2 enviado (WhatsApp)', date: '2026-10-01', hour: '09:05', done: false }],
    })
    expect(await pushTaskToRd(api, PUSH)).toEqual({ id: 'velha', reused: true })
    expect(api.createTask).not.toHaveBeenCalled()
    expect(api.updateTask).toHaveBeenCalledWith('velha', { task: { done: true } })
  })

  it('resposta sem done=true → PUT conclui', async () => {
    const api = fakeApi({ create: async () => ({ id: 'aberta', done: false }) })
    await pushTaskToRd(api, PUSH)
    expect(api.updateTask).toHaveBeenCalledWith('aberta', { task: { done: true } })
  })

  it('RD recusou (4xx) com `done` → tenta sem ele e conclui pelo PUT', async () => {
    let n = 0
    const api = fakeApi({
      create: async () => {
        n += 1
        if (n === 1) throw new RdCrmError(422, 'done não permitido')
        return { id: 'segunda', done: false }
      },
    })
    expect(await pushTaskToRd(api, PUSH)).toEqual({ id: 'segunda', reused: false })
    expect(api.createTask).toHaveBeenNthCalledWith(2, buildRdTaskBody(PUSH, { done: false }))
    expect(api.updateTask).toHaveBeenCalledWith('segunda', { task: { done: true } })
  })

  it('erro de rede/tempo NÃO tenta de novo aqui (pode ter criado) — sobe pra fila contar', async () => {
    const api = fakeApi({
      create: async () => {
        throw new Error('The operation was aborted due to timeout')
      },
    })
    await expect(pushTaskToRd(api, PUSH)).rejects.toThrow(/timeout/)
    expect(api.createTask).toHaveBeenCalledTimes(1)
  })
})

describe('enqueueRdTask', () => {
  beforeEach(() => {
    executed.length = 0
    executeImpl = async () => ({ rows: [] })
  })

  it('INSERT só com integração RD ligada e card da conta; duplicata não entra', async () => {
    await enqueueRdTask({
      accountId: '00000000-0000-0000-0000-00000000000a',
      dealId: '00000000-0000-0000-0000-00000000000d',
      taskId: '00000000-0000-0000-0000-000000000001',
      kind: 'email',
      subject: '  Cadência «X» — toque 1 enviado (E-mail)  ',
      notes: 'corpo',
      doneAt: new Date('2026-10-01T12:00:00Z'),
    })
    expect(executed).toHaveLength(1)
    const q = dialect.sqlToQuery(executed[0])
    expect(q.sql).toMatch(/INSERT INTO crm_task_outbox/)
    expect(q.sql).toMatch(/i\.provider = 'rdstation_crm'/)
    expect(q.sql).toMatch(/AND i\.enabled/)
    expect(q.sql).toMatch(/ON CONFLICT DO NOTHING/)
    expect(q.params).toContain('Cadência «X» — toque 1 enviado (E-mail)')
    expect(q.params).toContain('email')
    expect(q.params).toContain('2026-10-01T12:00:00.000Z')
  })

  it('nunca lança: banco fora (ou tabela ainda não criada) só vira log', async () => {
    executeImpl = async () => {
      throw new Error('relation "crm_task_outbox" does not exist')
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      enqueueRdTask({
        accountId: 'a',
        dealId: 'd',
        taskId: null,
        kind: 'whatsapp',
        subject: 'x',
        doneAt: new Date(),
      }),
    ).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('assunto vazio não enfileira nada', async () => {
    await enqueueRdTask({ accountId: 'a', dealId: 'd', taskId: null, kind: 'whatsapp', subject: '   ', doneAt: new Date() })
    expect(executed).toHaveLength(0)
  })
})
