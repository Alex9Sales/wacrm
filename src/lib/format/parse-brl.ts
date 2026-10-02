// Valor em reais DIGITADO ou COLADO pelo usuário → número. Puro (client-safe,
// sem db), um parser só pra todo campo de dinheiro do funil/negócio/proposta/
// produto.
//
// Por quê (02/10/2026, Rafael): o cliente colava "1.028,67" no valor do
// negócio e o sistema "não entendia" — o campo era <input type="number"> +
// parseFloat, que lê "1.028,67" como 1.028 (ou NaN) e grava um valor errado
// sem avisar. Cada tela tinha a sua gambiarra (replace(',', '.'), tirar todos
// os pontos…) e cada uma errava num caso diferente ("1028.67" virava 102867
// na fila de aprovação; "1.028,67" virava 0 no catálogo).
//
// Regra (formato brasileiro primeiro):
//   • TEM vírgula → a vírgula é o decimal e os pontos são separador de milhar
//     ("1.028,67" = 1028,67; "2,5" = 2,5; "1.234.567,89").
//   • SEM vírgula → o ponto só é milhar quando o número tem a CARA de milhar:
//     1 a 3 dígitos (sem zero à esquerda) e grupos de exatamente 3 depois de
//     cada ponto ("1.028" = mil e vinte e oito; "2.500" = dois mil e
//     quinhentos). Fora disso, um ponto só é decimal ("10.5" = dez e meio;
//     "1028.67"; "0.500" = meio).
//   • Aceita "R$" na frente, espaços (inclusive o espaço fino/inseparável que
//     o Intl põe em "R$ 1.028,67") e sinal de menos.
//   • Formato americano ("1,028.67" / "1,234,567") só é aceito quando NÃO
//     teria leitura brasileira válida — nunca muda o sentido de um valor BR.
//   • Vazio ou só "-" → null (quem chama decide se isso é 0 ou "sem valor").
//   • Qualquer outra coisa (letras, "1.02,5", "1,2,3") → null: melhor recusar
//     e avisar do que gravar um número inventado.

const SPACES = /[\s  ]/g

/** Milhar brasileiro: "1.028", "12.345.678" (1º grupo 1–3 dígitos, sem 0 na frente). */
const BR_THOUSANDS = /^[1-9]\d{0,2}(\.\d{3})+$/
/** Milhar americano + decimal opcional: "1,028.67", "1,234,567". */
const US_NUMBER = /^[1-9]\d{0,2}(,\d{3})+(\.\d*)?$/

/** Tira espaços, "R$"/"$" e o sinal; devolve o miolo e se era negativo. */
function stripDecor(raw: string): { body: string; negative: boolean } {
  let s = raw.replace(SPACES, '')
  let negative = false
  if (s.startsWith('-')) {
    negative = true
    s = s.slice(1)
  }
  s = s.replace(/^r?\$/i, '')
  // "R$ -10" (sinal depois do símbolo) também vale.
  if (!negative && s.startsWith('-')) {
    negative = true
    s = s.slice(1)
  }
  return { body: s, negative }
}

function toNumber(intPart: string, fracPart: string, negative: boolean): number | null {
  if (!intPart && !fracPart) return null
  const n = Number(`${intPart || '0'}.${fracPart || '0'}`)
  if (!Number.isFinite(n)) return null
  // Evita o "-0" (ex.: "-0,00") vazar pra tela/banco.
  return negative && n !== 0 ? -n : n
}

/** Leitura americana — só como último recurso (ver regra no topo). */
function parseUs(body: string, negative: boolean): number | null {
  if (!US_NUMBER.test(body)) return null
  const [intRaw, fracRaw = ''] = body.split('.')
  return toNumber(intRaw.replace(/,/g, ''), fracRaw, negative)
}

/**
 * Lê um valor em reais no formato brasileiro (ver regra no topo do arquivo).
 * Devolve `null` para vazio, "-" ou texto que não é um número reconhecível.
 * Número já numérico passa direto (se finito).
 */
export function parseBrl(input: string | number | null | undefined): number | null {
  if (input == null) return null
  if (typeof input === 'number') return Number.isFinite(input) ? input : null

  const { body, negative } = stripDecor(String(input))
  if (!body) return null
  if (!/^[\d.,]+$/.test(body)) return null
  if (!/\d/.test(body)) return null

  const commas = body.split(',').length - 1

  if (commas > 1) return parseUs(body, negative)

  if (commas === 1) {
    const [intRaw, fracRaw] = body.split(',')
    // "1,028.67": ponto DEPOIS da vírgula não tem leitura brasileira.
    if (fracRaw.includes('.')) return parseUs(body, negative)
    if (!/^\d*$/.test(fracRaw)) return null
    if (intRaw.includes('.')) {
      // Com vírgula decimal, ponto só pode ser milhar bem formado.
      if (!BR_THOUSANDS.test(intRaw)) return null
      return toNumber(intRaw.replace(/\./g, ''), fracRaw, negative)
    }
    if (!/^\d*$/.test(intRaw)) return null
    return toNumber(intRaw, fracRaw, negative)
  }

  // Sem vírgula.
  if (!body.includes('.')) return toNumber(body, '', negative)
  if (BR_THOUSANDS.test(body)) return toNumber(body.replace(/\./g, ''), '', negative)
  const dots = body.split('.').length - 1
  if (dots === 1) {
    const [intRaw, fracRaw] = body.split('.')
    return toNumber(intRaw, fracRaw, negative)
  }
  // "1.2.3", "10.50.3": vários pontos sem cara de milhar → não chuta.
  return null
}

/**
 * Leitura de um CAMPO de texto de dinheiro: separa "vazio" (o usuário não
 * preencheu — vale 0/null conforme o campo) de "inválido" (digitou algo que
 * não entendemos — a tela tem que avisar em vez de gravar 0 calada).
 */
export function parseBrlField(text: string | null | undefined): {
  value: number | null
  invalid: boolean
} {
  const raw = text ?? ''
  const value = parseBrl(raw)
  if (value !== null) return { value, invalid: false }
  const { body } = stripDecor(raw)
  return { value: null, invalid: body !== '' }
}

/**
 * Número → texto pt-BR pra mostrar NO CAMPO ("1.028,67"). Sem "R$" (o campo
 * já tem o rótulo/ícone) e sempre relido igual por `parseBrl` — o vai-e-volta
 * formatar → salvar nunca muda o valor. `minFractionDigits`: 2 pra dinheiro
 * ("1.000,00"); 0 pra percentual ("10" / "12,5").
 */
export function formatBrlInput(n: number, minFractionDigits = 2): string {
  if (!Number.isFinite(n)) return ''
  const min = Math.max(0, Math.min(2, minFractionDigits))
  return n.toLocaleString('pt-BR', {
    minimumFractionDigits: min,
    maximumFractionDigits: 2,
  })
}
