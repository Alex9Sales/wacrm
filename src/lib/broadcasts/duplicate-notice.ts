// ============================================================
// Texto do aviso "já tinham recebido esta mensagem hoje". PURO (client-safe).
//
// 15/09 (GoLink): o Vitor refez o disparo e Flash Baterias, Piso Decor e
// Vidro e Cia receberam a mesma imagem 2×. Agora quem já recebeu fica de
// fora (duplicate-sends.ts) e a tela conta quem ficou — com até 5 nomes, pra
// dar pra conferir sem abrir o disparo. Usado no formulário de Disparos e no
// disparo pela etapa do funil.
// ============================================================

import type { DuplicateSkip } from '@/lib/broadcasts/duplicate-sends'

const MAX_NAMES = 5

/** "3 contatos já tinham recebido esta mensagem hoje e ficaram de fora: A, B, C." */
export function duplicateSkipNotice(skipped: readonly Pick<DuplicateSkip, 'name'>[]): string | null {
  const n = skipped.length
  if (n === 0) return null
  const head =
    n === 1
      ? '1 contato já tinha recebido esta mensagem hoje e ficou de fora'
      : `${n} contatos já tinham recebido esta mensagem hoje e ficaram de fora`
  const names = skipped.map((s) => s.name?.trim() ?? '').filter(Boolean)
  if (names.length === 0) return `${head}.`
  const shown = names.slice(0, MAX_NAMES)
  const rest = n - shown.length
  return `${head}: ${shown.join(', ')}${rest > 0 ? ` e mais ${rest}` : ''}.`
}

/** Dica quando o disparo nem foi criado porque todo mundo já tinha recebido. */
export const SEND_AGAIN_HINT =
  'Marque "Enviar também pra quem já recebeu esta mensagem hoje" se quiser mandar de novo.'
