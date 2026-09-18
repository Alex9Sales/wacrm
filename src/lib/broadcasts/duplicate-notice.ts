// ============================================================
// Texto do aviso "já tinham recebido esta mensagem hoje". PURO (client-safe).
//
// 15/09 (GoLink): o Vitor refez o disparo e Flash Baterias, Pisos Modelo e
// Vidro e Cia receberam a mesma imagem 2×. Agora quem já recebeu fica de
// fora (duplicate-sends.ts) e a tela conta quem ficou — com até 5 nomes, pra
// dar pra conferir sem abrir o disparo. Usado no formulário de Disparos e no
// disparo pela etapa do funil.
//
// Revisão 15/09: o aviso diz O QUE bateu. No WhatsApp o texto decide (pega a
// imagem subida de novo com a mesma legenda), então "esta mensagem" enganava
// quem trocou a imagem e manteve o texto — agora é "o mesmo texto/legenda".
// Conferência 15/09: quem só está na fila de outro disparo não sai mais (o
// worker manda uma vez só), então não há aviso de "fila".
// ============================================================

import type { DuplicateReason, DuplicateSkip } from '@/lib/broadcasts/duplicate-sends'

const MAX_NAMES = 5

type SkipLike = Pick<DuplicateSkip, 'name'> & { reason?: DuplicateReason }

/** Começo da frase por motivo (sem motivo = texto antigo, "esta mensagem"). */
function headFor(reason: DuplicateReason | undefined, n: number): string {
  const one = n === 1
  const received = (what: string) =>
    one
      ? `1 contato já tinha recebido ${what} hoje e ficou de fora`
      : `${n} contatos já tinham recebido ${what} hoje e ficaram de fora`
  switch (reason) {
    case 'same_text':
      return received('o mesmo texto/legenda')
    case 'same_files':
      return received('os mesmos arquivos')
    case 'same_template':
      return received('o mesmo template com os mesmos valores')
    default:
      return received('esta mensagem')
  }
}

function sentence(reason: DuplicateReason | undefined, group: readonly SkipLike[]): string {
  const n = group.length
  const head = headFor(reason, n)
  const names = group.map((s) => s.name?.trim() ?? '').filter(Boolean)
  if (names.length === 0) return `${head}.`
  const shown = names.slice(0, MAX_NAMES)
  const rest = n - shown.length
  return `${head}: ${shown.join(', ')}${rest > 0 ? ` e mais ${rest}` : ''}.`
}

const REASON_ORDER: DuplicateReason[] = ['same_text', 'same_files', 'same_template']

/**
 * "3 contatos já tinham recebido o mesmo texto/legenda hoje e ficaram de
 * fora: A, B, C." — uma frase por motivo, na ordem acima; sem motivo por
 * último.
 */
export function duplicateSkipNotice(skipped: readonly SkipLike[]): string | null {
  if (skipped.length === 0) return null
  const parts: string[] = []
  for (const reason of REASON_ORDER) {
    const group = skipped.filter((s) => s.reason === reason)
    if (group.length > 0) parts.push(sentence(reason, group))
  }
  const unknown = skipped.filter((s) => !s.reason || !REASON_ORDER.includes(s.reason))
  if (unknown.length > 0) parts.push(sentence(undefined, unknown))
  return parts.join(' ')
}

/** Erro quando TODO mundo ficou de fora (nada foi criado). */
export function allDuplicatesError(skipped: readonly Pick<SkipLike, 'reason'>[]): string {
  const n = skipped.length
  if (n <= 1) return 'Este contato já recebeu esta mensagem nas últimas 24 h.'
  return `Todos os ${n} contatos já receberam esta mensagem nas últimas 24 h.`
}

/** Dica quando o disparo nem foi criado porque todo mundo já tinha recebido. */
export const SEND_AGAIN_HINT =
  'Marque "Enviar também pra quem já recebeu esta mensagem hoje" se quiser mandar de novo.'
