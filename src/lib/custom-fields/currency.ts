// Campo personalizado do tipo MOEDA (contato e negócio): texto digitado ↔
// valor gravado. Puro (client-safe, sem db) — usado pelo CustomFieldInput na
// tela e pelos server actions que salvam os valores.
//
// Por quê (02/10/2026, Rafael): o campo era <input type="number">, que recusa
// a vírgula — colar "1.028,67" virava "" e o valor sumia calado. Agora o campo
// é o MoneyInput (aceita "1.028,67", "R$ 1.028,67", "1028.67"), mas o que vai
// pro banco continua no MESMO formato que o type="number" sempre gravou:
//
//   número com PONTO decimal, sem milhar e sem "R$" — "1028.67", "1500",
//   "0.50". Centavos sempre com 2 casas; inteiro sem casas.
//
// Quem lê esse texto cru hoje (e não pode quebrar): a variável do campo no
// Disparo (entra na mensagem como está), o filtro do público do Disparo
// (é/não é/contém, comparação de texto), o contexto da IA (lead-form-context)
// e a cópia dos campos quando o card troca de funil (cross-funnel). Nenhum
// deles converte pra número — por isso o formato gravado NÃO muda, só a
// digitação.
//
// Valor antigo que não é número (gravado por automação, IA, API ou pelo
// formulário do lead, ex.: "a combinar") continua abrindo: aparece como está,
// marcado, e só é cobrado quando alguém MEXE nele (ver checkCurrencyValues).

import { formatBrlInput, parseBrl, parseBrlField } from '@/lib/format/parse-brl'

/** Número → texto gravado ("1028.67", "1500", "0.50"). Arredonda nos centavos. */
export function currencyToStored(n: number): string {
  const cents = Math.round(n * 100) / 100
  if (cents === 0) return '0' // também evita o "-0"
  return Number.isInteger(cents) ? String(cents) : cents.toFixed(2)
}

/**
 * Texto digitado no campo → o que o pai guarda (e depois vai pro banco).
 * Vazio → "". Número entendido → formato gravado. Texto que não é número →
 * fica COMO DIGITADO, pra o salvar recusar com aviso (nunca vira 0 calado).
 */
export function currencyInputToStored(text: string): string {
  const { value, invalid } = parseBrlField(text)
  if (invalid) return text
  return value === null ? '' : currencyToStored(value)
}

/**
 * Valor gravado → texto que aparece no campo ("1028.67" → "1.028,67").
 * Lê com o parser brasileiro: o formato gravado (ponto + 2 casas ou inteiro)
 * nunca tem cara de milhar, então volta exato. Valor antigo que não é número
 * volta cru — abre do jeito que está, sem sumir.
 */
export function currencyStoredToInput(stored: string | null | undefined): string {
  const raw = stored ?? ''
  const n = parseBrl(raw)
  return n === null ? raw : formatBrlInput(n)
}

/**
 * Confere os campos de moeda antes de gravar (server action do contato e do
 * negócio). `values` é o que a tela mandou; `existing`, o que já está gravado.
 *
 * - Valor IGUAL ao gravado passa intacto (byte a byte): salvar outro campo não
 *   pode reescrever nem travar por causa de um valor antigo que ninguém tocou.
 * - Valor novo entendido → formato gravado ("R$ 1.028,67" → "1028.67"), mesmo
 *   que venha de uma aba com o bundle velho (type="number").
 * - Valor novo que não é número → `invalidField` com o nome do campo; quem
 *   chama devolve o erro e NÃO grava nada.
 */
export function checkCurrencyValues(
  currencyFields: { id: string; name: string }[],
  values: Record<string, string>,
  existing: Record<string, string>,
): { values: Record<string, string>; invalidField: string | null } {
  const out: Record<string, string> = { ...values }
  for (const field of currencyFields) {
    if (!(field.id in values)) continue
    const raw = (values[field.id] ?? '').trim()
    if (!raw) continue
    if (raw === (existing[field.id] ?? '').trim()) continue
    const { value, invalid } = parseBrlField(raw)
    if (invalid) return { values, invalidField: field.name }
    out[field.id] = value === null ? '' : currencyToStored(value)
  }
  return { values: out, invalidField: null }
}

/** Aviso padrão quando o valor de um campo de moeda não é número. */
export function invalidCurrencyMessage(fieldName: string): string {
  return `Não entendi o valor de "${fieldName}". Use, por exemplo, 1.028,67.`
}

/**
 * Valor que a IA SUGERIU para um campo de moeda → formato gravado ("1500",
 * "1028.67"), ou null quando não é um valor em reais.
 *
 * Por quê (02/10/2026): a IA escreve dinheiro por extenso ("3 mil", "entre 3
 * e 5 mil", "R$ 5k") e, desde que o campo de moeda passou a recusar texto que
 * não é número (checkCurrencyValues), aceitar essa sugestão no card falhava
 * com um aviso genérico. Quem gera a sugestão (lib/ai/deal-suggest) descarta
 * o que vier assim; quem aceita (acceptDealSuggestion) confere de novo —
 * sugestão antiga, gravada antes desta regra, ainda pode estar pendente.
 *
 * Vazio e negativo também viram null: a IA lê um valor da conversa, e
 * dinheiro negativo ali não existe (o "Valor" do negócio já recusa ≤ 0).
 */
export function aiCurrencyToStored(raw: string | null | undefined): string | null {
  const { value, invalid } = parseBrlField(raw)
  if (invalid || value === null || value < 0) return null
  return currencyToStored(value)
}

/** Erro ao aceitar sugestão da IA cujo valor não é dinheiro (campo de moeda). */
export function invalidAiCurrencyMessage(value: string, fieldName: string): string {
  return `A IA sugeriu "${value}" para "${fieldName}", que não é um valor em reais. Preencha o campo à mão ou dispense a sugestão.`
}
