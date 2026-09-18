import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  connectReconnectingEventSource,
  reconnectDelayMs,
  type EventSourceLike,
  type ReconnectEnv,
} from './reconnecting-event-source'

const CONNECTING = 0
const OPEN = 1
const CLOSED = 2

class FakeEventSource implements EventSourceLike {
  static all: FakeEventSource[] = []
  readyState = CONNECTING
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.all.push(this)
  }
  close() {
    this.closed = true
    this.readyState = CLOSED
  }
  // Simulações do navegador
  serverOpens() {
    this.readyState = OPEN
    this.onopen?.({})
  }
  networkBlip() {
    // Queda de rede: o navegador volta pra CONNECTING e tenta sozinho.
    this.readyState = CONNECTING
    this.onerror?.({})
  }
  httpError502() {
    // Resposta de erro HTTP: o navegador DESISTE (CLOSED) — o bug de 18/09.
    this.readyState = CLOSED
    this.onerror?.({})
  }
}

function makeEnv() {
  let resume: (() => void) | null = null
  let hidden = false
  const env: ReconnectEnv = {
    create: (url) => new FakeEventSource(url),
    CLOSED,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    isHidden: () => hidden,
    onResume: (fn) => {
      resume = fn
      return () => {
        resume = null
      }
    },
  }
  return {
    env,
    resume: () => resume?.(),
    setHidden: (h: boolean) => {
      hidden = h
    },
  }
}

describe('reconnectDelayMs', () => {
  it('grows 1s, 2s, 4s… and caps at 30s', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })
})

describe('connectReconnectingEventSource', () => {
  beforeEach(() => {
    FakeEventSource.all = []
    vi.useFakeTimers()
  })

  it('reopens by itself after the browser gives up (HTTP error during a deploy)', () => {
    const { env } = makeEnv()
    const onOpen = vi.fn()
    const onDisconnect = vi.fn()
    connectReconnectingEventSource('/api/events', { onOpen, onDisconnect, onMessage: vi.fn() }, env)
    expect(FakeEventSource.all).toHaveLength(1)
    FakeEventSource.all[0].serverOpens()
    expect(onOpen).toHaveBeenCalledTimes(1)

    FakeEventSource.all[0].httpError502()
    expect(onDisconnect).toHaveBeenCalledTimes(1)
    expect(FakeEventSource.all).toHaveLength(1) // ainda não reabriu
    vi.advanceTimersByTime(1000)
    expect(FakeEventSource.all).toHaveLength(2) // reabriu depois de 1s
    FakeEventSource.all[1].serverOpens()
    expect(onOpen).toHaveBeenCalledTimes(2) // o inbox vê false→true e ressincroniza
  })

  it('backs off 1s, 2s, 4s while the server keeps failing, and resets after it opens', () => {
    const { env } = makeEnv()
    connectReconnectingEventSource('/api/events', { onMessage: vi.fn() }, env)
    FakeEventSource.all[0].httpError502()
    vi.advanceTimersByTime(1000)
    FakeEventSource.all[1].httpError502()
    vi.advanceTimersByTime(1999)
    expect(FakeEventSource.all).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeEventSource.all).toHaveLength(3)
    FakeEventSource.all[2].httpError502()
    vi.advanceTimersByTime(4000)
    expect(FakeEventSource.all).toHaveLength(4)
    FakeEventSource.all[3].serverOpens() // voltou: zera a espera
    FakeEventSource.all[3].httpError502()
    vi.advanceTimersByTime(1000)
    expect(FakeEventSource.all).toHaveLength(5)
  })

  it('does NOT open a second connection on a plain network blip (browser retries itself)', () => {
    const { env } = makeEnv()
    connectReconnectingEventSource('/api/events', { onMessage: vi.fn() }, env)
    FakeEventSource.all[0].serverOpens()
    FakeEventSource.all[0].networkBlip()
    vi.advanceTimersByTime(60_000)
    expect(FakeEventSource.all).toHaveLength(1)
  })

  it('reopens immediately when the tab comes back, without waiting the backoff', () => {
    const { env, resume } = makeEnv()
    connectReconnectingEventSource('/api/events', { onMessage: vi.fn() }, env)
    FakeEventSource.all[0].httpError502()
    resume()
    expect(FakeEventSource.all).toHaveLength(2)
    vi.advanceTimersByTime(60_000) // o timer pendente não abre uma terceira
    expect(FakeEventSource.all).toHaveLength(2)
  })

  it('ignores resume while the tab is hidden or the connection is alive', () => {
    const { env, resume, setHidden } = makeEnv()
    connectReconnectingEventSource('/api/events', { onMessage: vi.fn() }, env)
    FakeEventSource.all[0].serverOpens()
    resume()
    expect(FakeEventSource.all).toHaveLength(1)
    FakeEventSource.all[0].httpError502()
    setHidden(true)
    resume()
    expect(FakeEventSource.all).toHaveLength(1)
  })

  it('delivers messages and stops everything on dispose', () => {
    const { env } = makeEnv()
    const onMessage = vi.fn()
    const dispose = connectReconnectingEventSource('/api/events', { onMessage }, env)
    FakeEventSource.all[0].serverOpens()
    FakeEventSource.all[0].onmessage?.({ data: '{"type":"message.received"}' })
    FakeEventSource.all[0].onmessage?.({ data: '' })
    expect(onMessage).toHaveBeenCalledTimes(1)
    FakeEventSource.all[0].httpError502()
    dispose()
    vi.advanceTimersByTime(60_000)
    expect(FakeEventSource.all).toHaveLength(1)
    expect(FakeEventSource.all[0].closed).toBe(true)
  })
})
