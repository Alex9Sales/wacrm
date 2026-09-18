// ============================================================
// O que o lead JÁ respondeu no formulário → campos do card + contexto da IA.
//
// Zelo 18/09: o RD já dizia "São Paulo, acima de R$ 50 mil, quer franquia" e a
// Zélia perguntou a cidade e, três vezes, quanto a lead tinha pra investir —
// os dados só existiam como texto cru nas observações do card
// ("pensando_em_te_apresentar_a_opção…_investir_hoje?: acima_de_r$50_mil"). E o
// Renato: "no card não aparece o valor de investimento, nem cidade".
//
// Puro (sem banco). Cada cliente monta o formulário com perguntas diferentes,
// então o reconhecimento é pelo NOME da pergunta, sem acento e sem caixa.
// ============================================================

export interface LeadFacts {
  cidade: string | null
  estado: string | null
  investimento: string | null
  /** Quando pretende começar. */
  inicio: string | null
  interesse: string | null
  /** Campanha/formulário de onde o lead veio. */
  campanha: string | null
}

export type FactKey = keyof LeadFacts

/** Linhas que são controle do RD/sistema, não resposta do lead. */
const TECHNICAL_KEYS = new Set([
  'uuid',
  'lead stage',
  'fit score',
  'interest',
  'public url',
  'ficha no rd',
  'conversoes',
  'opportunity',
])

const canon = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/[?:]+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Qual fato uma pergunta do formulário responde. `null` = nenhum dos que viram
 * campo do card (a linha continua indo pra IA como está).
 */
export function factForKey(rawKey: string): FactKey | null {
  const k = canon(rawKey)
  if (!k || TECHNICAL_KEYS.has(k)) return null
  if (k === 'city' || /\bcidade\b/.test(k)) return 'cidade'
  if (k === 'state' || k === 'uf' || /\bestado\b/.test(k)) return 'estado'
  if (/invest|capital/.test(k)) return 'investimento'
  if (/quando .*come[c]|pretende come[c]ar|\bprazo\b/.test(k)) return 'inicio'
  if (/interesse/.test(k)) return 'interesse'
  if (k === 'campanha' || k === 'campaign') return 'campanha'
  return null
}

/**
 * Resposta de formulário que chegou como "slug" do RD ("acima_de_r$50_mil",
 * "sim,_tenho_interesse_em_conhecer") vira texto legível. Texto normal passa
 * intacto.
 */
export function prettyFormValue(raw: string): string {
  let v = (raw ?? '').trim()
  if (!v) return ''
  if (v.includes('_') && !/\s/.test(v) && !/^https?:\/\//i.test(v)) {
    v = v.replace(/_+/g, ' ').trim()
  }
  // "r$50" / "r$ 50" → "R$50" / "R$ 50"
  return v.replace(/\br\$/gi, 'R$')
}

/** Nome da pergunta legível: sem "_", sem ":"/"?" solto no fim, 1ª maiúscula. */
export function prettyFormKey(raw: string): string {
  const k = (raw ?? '')
    .replace(/_+/g, ' ')
    .replace(/[:\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return k ? k[0].toUpperCase() + k.slice(1) : ''
}

/**
 * Observações do card (o bloco "chave: valor" que a entrada de lead grava) →
 * pares. Corta no PRIMEIRO ": " — pergunta de formulário não tem ": " no meio,
 * e valor com URL tem "://", não ": ". Linha sem ": " fica como texto solto
 * (chave vazia): observação digitada à mão também é informação.
 */
export function parseNoteLines(notes: string | null | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const line of (notes ?? '').split('\n')) {
    const t = line.trim()
    if (!t) continue
    const i = t.indexOf(': ')
    if (i > 0) out.push([t.slice(0, i).trim(), t.slice(i + 2).trim()])
    else out.push(['', t])
  }
  return out
}

/**
 * Conversão que o PRÓPRIO RD gera, não o lead: quando a integração cria o
 * negócio no RD CRM, o RD Marketing registra uma conversão "Negociação criada
 * no RD Station CRM" (Zelo 18/09: um lead chegou 3x em 2 min por causa disso).
 * Não é campanha nem diz que tipo de lead é.
 */
export function isSyntheticConversion(label: string | null | undefined): boolean {
  return /negocia[cç][aã]o\s+criada/i.test(label ?? '')
}

/** Primeiro valor não vazio de cada fato. `campanha` cai na conversão. */
export function extractLeadFacts(pairs: Array<[string, string]>): LeadFacts {
  const facts: LeadFacts = {
    cidade: null,
    estado: null,
    investimento: null,
    inicio: null,
    interesse: null,
    campanha: null,
  }
  for (const [key, value] of pairs) {
    const f = factForKey(key)
    const v = prettyFormValue(value)
    if (f && v && !facts[f]) facts[f] = v
  }
  if (!facts.campanha) {
    const byKey = new Map(pairs.map(([k, v]) => [canon(k), v]))
    const conv = [byKey.get('ultima conversao'), byKey.get('primeira conversao')]
      .map((c) => (c ?? '').trim())
      .find((c) => c && !isSyntheticConversion(c))
    if (conv) facts.campanha = conv
  }
  return facts
}

/** Rótulo de cada fato — o nome do campo personalizado que a conta cria. */
export const FACT_LABELS: Record<FactKey, string> = {
  cidade: 'Cidade',
  estado: 'Estado',
  investimento: 'Investimento',
  inicio: 'Quando pretende começar',
  interesse: 'Interesse',
  campanha: 'Campanha',
}

/**
 * Campo personalizado do NEGÓCIO → fato que ele guarda (pelo nome que a conta
 * deu). Aceita as variações comuns ("UF", "Capital disponível", "Origem da
 * campanha"…). `null` = não é campo de fato.
 */
export function factForFieldName(fieldName: string): FactKey | null {
  const n = canon(fieldName)
  if (n === 'cidade') return 'cidade'
  if (n === 'estado' || n === 'uf') return 'estado'
  if (/invest|capital/.test(n)) return 'investimento'
  if (/quando .*come[c]|inicio|prazo/.test(n)) return 'inicio'
  if (n === 'interesse') return 'interesse'
  if (n === 'campanha' || n === 'origem da campanha') return 'campanha'
  return null
}

/**
 * Linhas pro prompt da IA: pergunta legível + resposta legível, sem as linhas
 * técnicas e sem repetir fato que já veio do campo personalizado (`skip`).
 */
export function leadLinesForPrompt(
  pairs: Array<[string, string]>,
  skip: Set<FactKey> = new Set(),
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const [key, value] of pairs) {
    const v = prettyFormValue(value)
    if (!v) continue
    if (key && TECHNICAL_KEYS.has(canon(key))) continue
    const f = key ? factForKey(key) : null
    if (f && skip.has(f)) continue
    const line = key ? `${prettyFormKey(key)}: ${v}` : v
    const id = canon(line)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(line)
  }
  return out
}
