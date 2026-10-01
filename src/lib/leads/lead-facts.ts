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
 * Conversão que o PRÓPRIO RD gera, não o lead: toda vez que um negócio ou uma
 * tarefa muda no RD CRM (inclusive pelo espelho do Fluxia) o RD Marketing
 * registra uma "conversão" com o nome do CRM — "Negociação criada/atualizada/
 * ganha no RD Station CRM", "Tarefa criada no RD Station CRM", "Tarefa
 * atualizada no RD Station CRM" e até só "RD Station CRM". Zelo 18/09:
 * "criada" fez um lead chegar 3x em 2 min; "atualizada" RECRIOU o card de um
 * lead logo depois de ele ser dado como perdido. Zelo 01/10: as de TAREFA e a
 * "RD Station CRM" pura passavam pelo filtro antigo (que só via "Negociação…"),
 * trocaram a campanha boa do lead por "unknown" e abriram 2 cards indevidos.
 * A regra casa o RÓTULO INTEIRO nos formatos que o RD gera ("RD Station CRM",
 * "<Negociação|Tarefa> <algo> no RD Station CRM") — não qualquer texto que
 * CITE o RD: uma landing "lp-comparativo-rd-station-crm" ou a campanha
 * "Alternativa ao RD Station CRM" são leads de verdade, e a conversão
 * sintética descarta o lead inteiro no webhook (revisão de 01/10).
 * Não é campanha nem lead novo.
 */
export function isSyntheticConversion(label: string | null | undefined): boolean {
  // canon tira acento/caixa/"_"; o "-" vira espaço pra pegar o slug
  // ("tarefa-criada-no-rd-station-crm") e "rdstation crm" sem espaço.
  const c = canon(label ?? '').replace(/[-\s]+/g, ' ').trim()
  return (
    /^(?:(?:negociacao|tarefa)\b.*\b(?:no|na|em) )?rd ?station ?crm$/.test(c) ||
    /\bnegociacao criada\b/.test(c) ||
    /^negociacao\b.*\brd ?station ?crm$/.test(c)
  )
}

/**
 * Um pedaço de origem que não diz nada (já em `canon`): "unknown",
 * "(not set)", "(none)", "desconhecido", "não informado", "n/a", "-"…
 * "(direct)" fica de fora de propósito: é o GA dizendo "acesso direto", que é
 * informação de canal, não ausência dela. O parêntese é UM só ocupando o
 * pedaço inteiro ([^()]*): com ".*" a campanha "(ABO) Leads Botox (Novo)"
 * virava genérica e sumia do card e do prompt (revisão de 01/10).
 */
const GENERIC_ORIGIN_PIECE =
  /^(?:\((?!direct\))[^()]*\)|unknown|desconhecid[oa]|nao informad[oa]|nao definid[oa]|sem origem|none|null|undefined|not set|n\/?a|-+)$/

/**
 * Separador de partes de uma origem: " / " (com espaço — sem espaço é data,
 * "11/09/26", ou URL) e "|" com ou sem espaço. Capturado pra devolver a origem
 * com os separadores ORIGINAIS quando só um pedaço cai.
 */
const ORIGIN_SEP = /(\s+\/\s+|\s*\|\s*)/

/** Um pedaço sem nada genérico volta INTACTO; com "x/unknown" colado, limpa. */
function cleanOriginPiece(piece: string): string {
  const p = piece.trim()
  if (!p || GENERIC_ORIGIN_PIECE.test(canon(p))) return ''
  // URL fica como está: cortar "/unknown" do caminho a quebraria.
  if (!p.includes('/') || p.includes('://')) return p
  const subs = p.split('/')
  const generic = subs.map((s) => !!s.trim() && GENERIC_ORIGIN_PIECE.test(canon(s)))
  if (!generic.some(Boolean)) return p // "11/09/26": nada a tirar
  return subs
    .filter((s, i) => !generic[i] && s.trim())
    .map((s) => s.trim())
    .join('/')
}

/**
 * Origem (campanha, canal, fonte/meio) só com o que diz algo, parte a parte:
 * "Facebook Ads / unknown" → "Facebook Ads", "unknown | Instant Forms" →
 * "Instant Forms", "unknown / unknown" → "". O RD Marketing grava "unknown"
 * em cada pedaço que não rastreou (lead sem UTM) — Zelo 01/10: o marketing via
 * na nota "Campanha: unknown / Canal da conversão: unknown / unknown" e a
 * Zélia recebia o mesmo no prompt. Sem nada genérico, devolve o texto como
 * veio (com os separadores originais).
 */
export function cleanOrigin(value: string | null | undefined): string {
  const tokens = (value ?? '').trim().split(ORIGIN_SEP)
  let out = ''
  // Índices pares = pedaços; ímpares = o separador que veio antes do seguinte.
  for (let i = 0; i < tokens.length; i += 2) {
    const piece = cleanOriginPiece(tokens[i] ?? '')
    if (!piece) continue
    out = out ? `${out}${tokens[i - 1] ?? ' / '}${piece}` : piece
  }
  return out.trim()
}

/**
 * Origem que NÃO diz nada: "unknown", "(none)", "(not set)", "desconhecido",
 * "unknown / unknown"… É o que o RD Marketing grava quando não rastreou a
 * origem (lead sem UTM) — e virava "Campanha: unknown" no card (Zelo 01/10,
 * pergunta do Jordan). Vazio também conta como genérico. Mesma régua do
 * `cleanOrigin`: genérico = não sobra nada depois de limpar.
 */
export function isGenericOrigin(value: string | null | undefined): boolean {
  return cleanOrigin(value) === ''
}

/**
 * Origem/campanha que SERVE: limpa parte a parte (cleanOrigin) e nunca um
 * rótulo do próprio RD CRM. Antes de 01/10, sem "Campanha" no pacote, o
 * fallback pro identificador da conversão podia gravar "Tarefa criada no RD
 * Station CRM" como Campanha do card — e ela passaria por "campanha boa" no
 * primeiro toque. '' = não serve.
 */
export function usefulOrigin(value: string | null | undefined): string {
  return isSyntheticConversion(value) ? '' : cleanOrigin(value)
}

/** Chaves das observações que falam de ORIGEM (o que o RD gravou). */
const ORIGIN_KEYS = new Set([
  'primeira conversao',
  'ultima conversao',
  'campanha',
  'campaign',
  'canal da conversao',
])

/**
 * Primeiro valor não vazio de cada fato. `campanha` genérica ("unknown") não
 * conta — Zelo 01/10: ela ocupava o lugar e o fallback nunca rodava — e cai no
 * identificador da conversão REAL (última, senão primeira; nunca a do RD CRM).
 */
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
    if (!f || facts[f]) continue
    const pretty = prettyFormValue(value)
    const v = f === 'campanha' ? usefulOrigin(pretty) : pretty
    if (v) facts[f] = v
  }
  if (!facts.campanha) {
    const byKey = new Map(pairs.map(([k, v]) => [canon(k), v]))
    const conv = [byKey.get('ultima conversao'), byKey.get('primeira conversao')]
      .map((c) => usefulOrigin(c))
      .find(Boolean)
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
 *
 * Linhas de ORIGEM (Campanha, Canal da conversão, Primeira/Última conversão)
 * só com o que diz algo: Zelo 01/10 — a Zélia recebia "Campanha: unknown" e
 * "Canal da conversão: unknown / unknown". Observação gravada antes do
 * conserto ainda pode trazer a conversão do PRÓPRIO RD CRM ("Tarefa criada no
 * RD Station CRM") como se fosse do lead: essa linha também fica de fora.
 */
export function leadLinesForPrompt(
  pairs: Array<[string, string]>,
  skip: Set<FactKey> = new Set(),
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const [key, value] of pairs) {
    const ck = key ? canon(key) : ''
    let v = prettyFormValue(value)
    // Origem: sem pedaço genérico e nunca o rótulo do próprio RD CRM.
    if (ORIGIN_KEYS.has(ck)) v = usefulOrigin(v)
    if (!v) continue
    if (key && TECHNICAL_KEYS.has(ck)) continue
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
