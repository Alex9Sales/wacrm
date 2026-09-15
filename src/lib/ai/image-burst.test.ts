import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeRedis, redisStore } from '@/lib/__mocks__/fake-redis'

vi.mock('ioredis', () => ({ Redis: FakeRedis }))
vi.mock('@/lib/queue/connection', () => ({ bullConnection: () => ({}) }))

import { IMAGE_BURST_LIMIT, IMAGE_BURST_WINDOW_MS, __resetImageBurstForTests, shouldDescribeImage } from './image-burst'

// 14/09 (GoLink): 86 fotos de fachada em 1 minuto estouraram o limite por minuto
// da chave OpenAI da conta e 81 ficaram sem descrição.
describe('shouldDescribeImage', () => {
  beforeEach(() => {
    redisStore.clear()
    __resetImageBurstForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('numa rajada de 86 fotos, só as 3 primeiras ganham descrição', async () => {
    const r = await Promise.all(Array.from({ length: 86 }, () => shouldDescribeImage('conv-nos-redes')))
    expect(r.filter((x) => x.describe)).toHaveLength(IMAGE_BURST_LIMIT)
    expect(r.map((x) => x.position).sort((a, b) => a! - b!)).toEqual(Array.from({ length: 86 }, (_, i) => i + 1))
  })

  it('a rajada é por conversa: outra conversa não é afetada', async () => {
    for (let i = 0; i < 10; i++) await shouldDescribeImage('conv-a')
    expect((await shouldDescribeImage('conv-b')).describe).toBe(true)
  })

  it('passada a janela de 60 s, a conversa volta a ter descrição', async () => {
    vi.useFakeTimers()
    for (let i = 0; i < 5; i++) await shouldDescribeImage('conv-c')
    expect((await shouldDescribeImage('conv-c')).describe).toBe(false)
    vi.advanceTimersByTime(IMAGE_BURST_WINDOW_MS + 1)
    expect((await shouldDescribeImage('conv-c')).describe).toBe(true)
  })

  it('foto avulsa (o caso normal) continua sendo descrita', async () => {
    expect(await shouldDescribeImage('conv-d')).toEqual({ describe: true, position: 1 })
  })
})
