// ============================================================
// 🏷️ Tokens por destinatário do disparo (broadcast_recipients.vars).
//
// Duas coisas moram no mesmo campo e NÃO significam a mesma coisa:
//  • MENSAGEM PRÓPRIA ({{mensagem}} do "Chamar de volta"): cada pessoa recebe
//    um texto diferente, então a trava de "já recebeu isso nas últimas 24 h"
//    não se aplica.
//  • NOME DA PLANILHA ({{nome}}, {{primeiro_nome}}): o mesmo texto para todo
//    mundo, só a saudação muda. A trava continua valendo.
//
// 22/09 (GoLink): o João montou a planilha com "telefone, nome" e a mensagem
// saiu com o nome ANTIGO do contato ("Olá, Instituto Talentos!" em vez de
// "Olá, Francinete"). O nome que ele escreveu na planilha passa a valer na
// mensagem daquele disparo — o cadastro continua com a regra de sempre
// (planilha nunca troca nome digitado no CRM nem o da agenda).
//
// Puro (sem DB) — usado na action, no enfileiramento e no worker.
// ============================================================

import { firstNameForGreeting } from '@/lib/cdl/names'

/** Tokens que são só saudação — não fazem do envio uma "mensagem própria". */
export const NAME_ONLY_VARS = ['nome', 'primeiro_nome'] as const

/**
 * Tokens do nome que veio na planilha. `primeiro_nome` passa pelo mesmo
 * filtro de "parece nome de pessoa" do resto do produto: planilha com
 * "Instituto Talentos" não vira "Olá, Instituto!".
 */
export function csvNameVars(name: string | null | undefined): Record<string, string> | null {
  const nome = (name ?? '').trim()
  if (!nome) return null
  const primeiro = firstNameForGreeting(nome)
  return { nome, ...(primeiro ? { primeiro_nome: primeiro } : {}) }
}

/**
 * Este destinatário tem TEXTO próprio (e não só a saudação)? É o que decide
 * pular a checagem de "já recebeu a mesma mensagem em outro disparo".
 */
export function hasCustomBodyVars(vars: unknown): boolean {
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return false
  return Object.keys(vars as Record<string, unknown>).some(
    (k) => !(NAME_ONLY_VARS as readonly string[]).includes(k.toLowerCase()),
  )
}

/** Algum destinatário tem texto próprio? (a versão do lote, para o disparo inteiro) */
export function anyCustomBodyVars(byRecipient: Record<string, Record<string, string>> | undefined): boolean {
  if (!byRecipient) return false
  return Object.values(byRecipient).some(hasCustomBodyVars)
}
