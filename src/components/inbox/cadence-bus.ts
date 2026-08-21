'use client'

// Barramento leve pra sincronizar o botão de cadência do compositor e o bloco
// da aba lateral: ao inscrever/encerrar num, o outro recarrega. Chave = id da
// conversa (ou do negócio). In-memory, por aba.

type Cb = () => void
const subs = new Map<string, Set<Cb>>()

export function onCadenceChange(key: string, cb: Cb): () => void {
  let set = subs.get(key)
  if (!set) {
    set = new Set()
    subs.set(key, set)
  }
  set.add(cb)
  return () => {
    set?.delete(cb)
    if (set && set.size === 0) subs.delete(key)
  }
}

export function emitCadenceChange(key: string | null | undefined): void {
  if (!key) return
  subs.get(key)?.forEach((cb) => {
    try {
      cb()
    } catch {
      /* ignore */
    }
  })
}
