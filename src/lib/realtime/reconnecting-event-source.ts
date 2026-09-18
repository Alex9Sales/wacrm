// ============================================================
// EventSource que NÃO morre depois de um deploy.
//
// O EventSource do navegador só se reconecta sozinho quando a REDE cai. Se a
// resposta vier com erro HTTP (502/503 enquanto o deploy troca o container),
// ele fecha de vez (readyState CLOSED) — a aba fica aberta sem nunca mais
// receber mensagem nova até alguém recarregar. Caso Dra. Joyce 18/09: o
// computador da Karen parou de mostrar mensagens de pacientes depois dos
// deploys da manhã; deslogar e logar resolveu.
//
// Aqui: quando o navegador desiste, reabrimos com espera crescente (1s, 2s,
// 4s… 30s) e na hora quando a aba volta a ficar visível ou a internet volta.
// Sem React — testável com um EventSource falso.
// ============================================================

/** Espera antes da próxima tentativa: 1s, 2s, 4s… no máximo 30s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt))
}

/** O mínimo de EventSource que usamos (o do navegador ou um falso nos testes). */
export interface EventSourceLike {
  readyState: number
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
  close(): void
}

export interface ReconnectEnv {
  create: (url: string) => EventSourceLike
  /** Valor de EventSource.CLOSED (2). */
  CLOSED: number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
  /** Assina "aba visível" / "voltou a internet"; devolve o cancelamento. */
  onResume?: (fn: () => void) => () => void
  isHidden?: () => boolean
}

export function connectReconnectingEventSource(
  url: string,
  handlers: {
    onOpen?: () => void
    onMessage: (data: string) => void
    onDisconnect?: () => void
  },
  env: ReconnectEnv,
): () => void {
  let es: EventSourceLike | null = null
  let retryTimer: unknown
  let attempt = 0
  let disposed = false

  const open = () => {
    if (disposed) return
    if (es && es.readyState !== env.CLOSED) return // já aberta ou abrindo
    env.clearTimeout(retryTimer)
    const current = env.create(url)
    es = current

    current.onopen = () => {
      attempt = 0
      handlers.onOpen?.()
    }
    current.onmessage = (ev) => {
      if (ev?.data) handlers.onMessage(ev.data)
    }
    current.onerror = () => {
      handlers.onDisconnect?.()
      // Queda transitória: o navegador tenta de novo sozinho. Só assumimos
      // quando ele DESISTIU (CLOSED).
      if (disposed || current.readyState !== env.CLOSED) return
      current.close()
      if (es === current) es = null
      retryTimer = env.setTimeout(open, reconnectDelayMs(attempt))
      attempt += 1
    }
  }

  const reopenNow = () => {
    if (disposed || env.isHidden?.()) return
    if (es && es.readyState !== env.CLOSED) return
    attempt = 0
    open()
  }

  open()
  const stopResume = env.onResume?.(reopenNow)

  return () => {
    disposed = true
    env.clearTimeout(retryTimer)
    stopResume?.()
    es?.close()
    es = null
  }
}

/** Ambiente real do navegador. */
export function browserReconnectEnv(): ReconnectEnv {
  return {
    create: (url) => new EventSource(url) as unknown as EventSourceLike,
    CLOSED: EventSource.CLOSED,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id as number | undefined),
    isHidden: () => document.hidden,
    onResume: (fn) => {
      document.addEventListener('visibilitychange', fn)
      window.addEventListener('online', fn)
      return () => {
        document.removeEventListener('visibilitychange', fn)
        window.removeEventListener('online', fn)
      }
    },
  }
}
