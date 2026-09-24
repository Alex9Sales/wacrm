// ============================================================
// Conserto de código copiado errado entre ferramentas.
//
// 24/09 (Família do Gás): a Maria lê o código do produto no consultar_estoque
// e o repete no criar_pedido. São 36 caracteres transcritos de cabeça — e ela
// erra. Em 7 dias: 102 pedidos com o código certo e 8 perdidos com variações
// dele (um dígito trocado, um caractere a mais, a ponta truncada). O ERP
// responde "Produto nao encontrado" e a venda morre com o cliente já tendo
// dito "pode".
//
// Nenhuma instrução de prompt impede um modelo de trocar um dígito. O que
// resolve é conferir: o código tem que ser um dos que as ferramentas DESTA
// conversa devolveram. Quando não é, mas há exatamente UM conhecido que
// começa igual, é erro de transcrição — e a gente corrige.
// ============================================================

/** Quanto do começo precisa bater pra ser "o mesmo código digitado errado". */
export const MIN_PREFIX = 16

const UUID_LIKE = /^[0-9a-f]{6,}[0-9a-f-]*$/i

/** Parece um código de sistema (e não um nome, um valor, um telefone)? */
export function looksLikeId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const v = value.trim()
  // Pelo menos 3 grupos hexadecimais separados por hífen: descarta telefone,
  // CEP, data e qualquer número solto que o cliente tenha dito.
  return v.length >= 20 && v.split('-').length >= 4 && UUID_LIKE.test(v)
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

/**
 * O código certo para um valor que não existe, ou null quando não dá para ter
 * certeza. Só devolve com UM candidato: dois parecidos é ambiguidade, e
 * corrigir no chute mandaria o produto errado para a casa do cliente.
 */
export function closestKnownId(value: string, known: Iterable<string>): string | null {
  const alvo = value.trim().toLowerCase()
  if (!alvo) return null
  const candidatos: string[] = []
  for (const k of known) {
    const id = k.trim().toLowerCase()
    if (!id) continue
    if (id === alvo) return null // já está certo
    if (commonPrefix(id, alvo) >= MIN_PREFIX) candidatos.push(k.trim())
  }
  return candidatos.length === 1 ? candidatos[0] : null
}

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** Todo código que apareceu no que as ferramentas responderam. */
export function idsInText(text: string | null | undefined): string[] {
  if (!text) return []
  return [...new Set((text.match(UUID_IN_TEXT) ?? []).map((s) => s.toLowerCase()))]
}

export interface IdRepair {
  param: string
  from: string
  to: string
}

/**
 * Troca os códigos errados pelos certos. Devolve os argumentos (os mesmos,
 * quando não havia o que consertar) e a lista do que mudou, pra quem chama
 * registrar — conserto silencioso esconde que o modelo está errando.
 */
export function repairIdArgs(
  args: Record<string, unknown>,
  known: Iterable<string>,
): { args: Record<string, unknown>; repairs: IdRepair[] } {
  const conhecidos = [...known]
  if (conhecidos.length === 0) return { args, repairs: [] }

  const repairs: IdRepair[] = []
  let out: Record<string, unknown> | null = null
  for (const [param, value] of Object.entries(args)) {
    if (!looksLikeId(value)) continue
    const certo = closestKnownId(value, conhecidos)
    if (!certo) continue
    out ??= { ...args }
    out[param] = certo
    repairs.push({ param, from: value.trim(), to: certo })
  }
  return { args: out ?? args, repairs }
}
