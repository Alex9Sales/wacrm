// ============================================================
// 🩺 O paciente do compromisso VAI JUNTO para o Google — na DESCRIÇÃO.
//
// 01/10 (dona de uma clínica): "como eu faço para quando eu agendar o paciente as
// informações do paciente ficarem vinculadas na agenda do Google também?". Ela
// criou "RSC" no CRM com a paciente escolhida e no Google apareceu só "rsc" —
// o CRM mandava título, descrição e local, e o paciente ficava para trás.
//
// Agora a descrição leva, no FIM, um bloco do FluxiaCRM com "Paciente:" e
// "Telefone:", no mesmo formato que o Capim já escreve — é o que o import
// (event-contact.ts → phoneFromDescription) lê para religar o contato.
//
// O TÍTULO não é tocado: vai como foi digitado. A rodada 1 (01/10) punha
// " · <nome>" no título e a revisão achou meia dúzia de jeitos de o sufixo
// crescer ou ficar com o paciente antigo — não há onde guardar o que foi
// mandado sem depender de texto editável. O bloco da descrição tem marcadora
// própria, então dá para trocá-lo sem adivinhar.
//
// SÓ para quem optou (`googlePatientInfo` nas configurações da conta, padrão
// desligado) e NUNCA em reunião com convidados: o Google manda a descrição no
// convite por e-mail, e nome + telefone de paciente não podem ir para fora.
//
// ⚠️ IDA E VOLTA. O sync de 5 em 5 min SOBRESCREVE a descrição do CRM com a do
// Google, então o bloco volta para cá sozinho — às vezes em HTML, quando alguém
// edita pela tela do Google. Tudo aqui tem que ser idempotente: aplicar de novo
// sobre o que voltou não pode duplicar nada, e nenhuma linha fora do bloco sai
// (as do Capim, o que a recepção digitou).
//
// Sem 'server-only': o worker do sync alcança este arquivo.
// ============================================================

/** Nome e telefone crus do contato ligado ao compromisso (como estão no banco). */
export type PacienteDoEvento = { name: string | null; phone: string | null }

/** Linha que abre o bloco do FluxiaCRM na descrição do Google. */
export const MARCADOR_FLUXIA = '— FluxiaCRM —'

// ------------------------------------------------------------
// Descrição em texto OU em HTML.
//
// Quando alguém edita a descrição pela tela do Google, ela volta em HTML:
// "<br>", "<div>…</div>", "<p>", "&nbsp;", "&mdash;", "<b>" em volta. Para achar o
// bloco, cada linha é lida já sem tags e sem entidades; para tirá-lo, corta-se
// o trecho ORIGINAL daquelas linhas — o HTML do resto fica como estava.
// ------------------------------------------------------------

// Quebras de linha. `</div><div>` (e `</p><p>`) é UMA quebra: é assim que o
// editor do Google separa duas linhas. Vem antes na alternância de propósito.
const QUEBRA_RE =
  /<\/(?:div|p)\s*>\s*<(?:div|p)(?:\s[^<>]*)?>|\r?\n|<br\s*\/?>|<\/?(?:div|p)(?:\s[^<>]*)?>/gi
// Tag de verdade começa com letra: o "<3" de um nome não é tag.
const TAG_RE = /<\/?[a-z][^<>]*>/gi
const ENTIDADES: Record<string, string> = {
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodificarEntidades(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (inteira, e: string) => {
    const k = e.toLowerCase()
    if (k.startsWith('#')) {
      const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : inteira
    }
    return ENTIDADES[k] ?? inteira
  })
}

/** Um trecho do original como a recepção o lê: sem tags, sem entidades, espaço único. */
function textoPlano(trecho: string): string {
  // `\s` já cobre o espaço duro (U+00A0) que o &nbsp; vira.
  return decodificarEntidades(trecho.replace(TAG_RE, '')).replace(/\s+/g, ' ').trim()
}

type Linha = {
  /** Trecho da linha no ORIGINAL: [ini, fim). */
  ini: number
  fim: number
  /** O que a linha diz, já sem HTML. */
  texto: string
  /** Onde termina a quebra que fecha esta linha, e se ela é um `</div>`/`</p>` sozinho. */
  quebraFim: number | null
  quebraFecha: boolean
}

function linhasDe(texto: string): Linha[] {
  const out: Linha[] = []
  const re = new RegExp(QUEBRA_RE.source, 'gi')
  let ini = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(texto))) {
    out.push({
      ini,
      fim: m.index,
      texto: textoPlano(texto.slice(ini, m.index)),
      quebraFim: m.index + m[0].length,
      quebraFecha: /^<\/(?:div|p)\s*>$/i.test(m[0]),
    })
    ini = m.index + m[0].length
  }
  out.push({ ini, fim: texto.length, texto: textoPlano(texto.slice(ini)), quebraFim: null, quebraFecha: false })
  return out
}

/** A descrição inteira em texto puro, uma linha por quebra (texto ou HTML). */
export function descricaoEmTexto(description: string | null | undefined): string {
  return linhasDe(description ?? '')
    .map((l) => l.texto)
    .join('\n')
}

/** Tem HTML? (Então o bloco entra com `<br>`, não com quebra de texto.) */
function temHtml(s: string): boolean {
  return /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/i.test(s)
}

const MARCADOR_PLANO = textoPlano(MARCADOR_FLUXIA).toLowerCase()

/**
 * Trechos do original ocupados por blocos do FluxiaCRM: a marcadora numa linha
 * só, seguida das NOSSAS linhas "Paciente:" e "Telefone:" (cada uma opcional,
 * nesta ordem). Vão junto as linhas em branco antes da marcadora — são o
 * espaçamento que nós mesmos pusemos.
 */
function trechosDoBloco(texto: string): Array<[number, number]> {
  const ls = linhasDe(texto)
  const cortes: Array<[number, number]> = []
  let i = 0
  while (i < ls.length) {
    if (ls[i].texto.toLowerCase() !== MARCADOR_PLANO) {
      i++
      continue
    }
    let ultima = i
    if (ultima + 1 < ls.length && /^paciente\s*:/i.test(ls[ultima + 1].texto)) ultima++
    if (ultima + 1 < ls.length && /^telefone\s*:/i.test(ls[ultima + 1].texto)) ultima++

    let anterior = i - 1
    while (anterior >= 0 && !ls[anterior].texto) anterior--
    let ini: number
    let fim = ls[ultima].fim
    if (anterior >= 0) {
      // Logo depois da última linha com texto — mas sem levar o `</div>` que a
      // fecha, senão a tag dela fica aberta.
      const a = ls[anterior]
      ini = a.quebraFecha && a.quebraFim !== null ? a.quebraFim : a.fim
    } else {
      // Bloco no começo: vai junto o espaço até a próxima linha com texto.
      ini = 0
      let prox = ultima + 1
      while (prox < ls.length && !ls[prox].texto) prox++
      fim = prox < ls.length ? ls[prox].ini : texto.length
    }
    cortes.push([ini, fim])
    i = ultima + 1
  }
  return cortes
}

/**
 * A descrição sem o bloco do FluxiaCRM. Nenhuma outra linha sai. Sem bloco,
 * devolve a descrição EXATAMENTE como veio (nem o espaço do fim muda).
 */
export function tirarBlocoFluxia(description: string | null | undefined): string {
  const texto = description ?? ''
  if (!/fluxiacrm/i.test(texto)) return texto
  const cortes = trechosDoBloco(texto)
  if (!cortes.length) return texto
  let out = ''
  let cursor = 0
  for (const [ini, fim] of cortes) {
    if (ini > cursor) out += texto.slice(cursor, ini)
    cursor = Math.max(cursor, fim)
  }
  out += texto.slice(cursor)
  // Sobrou só casca de HTML (um "</div>" solto)? Então não sobrou nada.
  return descricaoEmTexto(out).trim() ? out.trim() : ''
}

// ------------------------------------------------------------
// Quem é o paciente, do jeito que vai no bloco.
// ------------------------------------------------------------

/**
 * Nome de verdade do contato, numa linha só — ou null.
 *
 * Sem nenhuma letra não é nome: o próprio telefone, um CPF/CNPJ gravado no
 * lugar do nome ("123.456.789-01"), um perfil do WhatsApp só de emoji. Nesses
 * casos vai só o telefone — documento não pode parar na agenda do Google.
 * "<" e ">" saem: o bloco pode ir dentro de HTML, e "Ana <3" quebraria a linha.
 */
function nomeDoPaciente(name: string | null | undefined): string | null {
  const n = (name ?? '').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!/\p{L}/u.test(n)) return null
  return n
}

/** DDD com os dois dígitos de 1 a 9; celular (11 dígitos) começa com 9; fixo
 *  ou celular sem o 9º dígito (10) começa de 2 a 9. */
function brasileiroValido(nacional: string): boolean {
  if (!/^[1-9]{2}/.test(nacional)) return false
  if (nacional.length === 11) return nacional[2] === '9'
  if (nacional.length === 10) return /[2-9]/.test(nacional[2])
  return false
}

/**
 * Telefone no formato que a recepção lê: "(11) 98765-4321".
 *
 * Com ou sem o 55 (o ERP grava sem). Só formata como brasileiro o que é número
 * brasileiro válido: "12025550123" (EUA, sem o +) virava "(12) 02555-0123", com
 * cara de São José dos Campos. O resto vai com "+" e os dígitos. Menos de 10
 * dígitos não identifica ninguém (falta o DDD) e não vai.
 */
export function telefoneLegivel(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '')
  if (d.length < 10) return null
  const nacional = d.startsWith('55') && (d.length === 12 || d.length === 13) ? d.slice(2) : d
  if (brasileiroValido(nacional)) {
    const resto = nacional.slice(2)
    return `(${nacional.slice(0, 2)}) ${resto.slice(0, -4)}-${resto.slice(-4)}`
  }
  return `+${d}`
}

/**
 * O texto já traz este telefone? Compara pelos 8 últimos dígitos (a mesma chave
 * do import, `phoneKey`), em qualquer trecho com cara de telefone — o Capim
 * escreve "(54) 9917-1108" e o CRM guarda "5554999171108".
 */
export function textoTemTelefone(texto: string | null | undefined, phone: string | null | undefined): boolean {
  const alvo = (phone ?? '').replace(/\D/g, '')
  if (alvo.length < 8) return false
  const chave = alvo.slice(-8)
  for (const trecho of (texto ?? '').match(/\+?\(?\d[\d \t().-]*\d/g) ?? []) {
    const d = trecho.replace(/\D/g, '')
    // ≥ 10: com DDD. Abaixo disso é cadeira, id do Capim, data — não telefone.
    if (d.length >= 10 && d.slice(-8) === chave) return true
  }
  return false
}

/**
 * Descrição que vai para o Google: a do CRM, sem o bloco antigo, com o bloco
 * do paciente atual no fim. Sem paciente, só tira o bloco antigo — é assim que
 * desligar o paciente LIMPA o Google (quem chama manda '' quando der vazio).
 *
 * Não põe bloco quando a descrição já traz o telefone do paciente — o evento do
 * Capim já vem com "Paciente:" e "Telefone:", repetir só polui. Quando a
 * descrição está em HTML, o bloco entra com `<br>`: um "\n" no meio de HTML
 * vira espaço, e o bloco apareceria numa linha só.
 */
export function descricaoParaGoogle(
  description: string | null | undefined,
  paciente: PacienteDoEvento | null,
): string {
  const base = tirarBlocoFluxia(description)
  const nome = nomeDoPaciente(paciente?.name)
  const telefone = telefoneLegivel(paciente?.phone)
  // Nenhuma das duas linhas leva "<" ou ">": o nome sai limpo de nomeDoPaciente
  // e o telefone legível só tem dígitos, parênteses, espaço, hífen e "+".
  const linhas = [nome && `Paciente: ${nome}`, telefone && `Telefone: ${telefone}`].filter(
    (l): l is string => Boolean(l),
  )
  if (!linhas.length) return base
  if (telefone !== null && textoTemTelefone(descricaoEmTexto(base), paciente?.phone)) return base
  const quebra = temHtml(base) ? '<br>' : '\n'
  const bloco = [MARCADOR_FLUXIA, ...linhas].join(quebra)
  const b = base.trim()
  return b ? `${b}${quebra}${quebra}${bloco}` : bloco
}

// ------------------------------------------------------------
// Quando o paciente vai.
// ------------------------------------------------------------

// A sala do Meet vira o "local" do evento (sync.ts) — é o rastro que fica na
// linha do CRM de que aquilo é reunião com gente de fora.
const LINK_DE_REUNIAO = /meet\.google\.com|zoom\.us\/|teams\.microsoft\.com|teams\.live\.com/i

/** A linha do evento tem cara de reunião com convidados (link de videochamada)? */
export function pareceReuniaoComConvidados(ev: {
  location?: string | null
  description?: string | null
}): boolean {
  return LINK_DE_REUNIAO.test(`${ev.location ?? ''}\n${ev.description ?? ''}`)
}

/**
 * Este push leva o paciente para o Google?
 *
 * - Só na conta que optou (`googlePatientInfo === true`; qualquer outro valor
 *   gravado no jsonb conta como desligado).
 * - Nunca em evento com convidados: na criação, convidados ou sala do Meet
 *   pedidos; na edição, link de videochamada na linha do evento. O Google manda
 *   a descrição no convite por e-mail — o convite da Zelo levaria
 *   "Paciente: <lead>" e o telefone para fora.
 */
export function levarPacienteAoGoogle(args: {
  ligadoNaConta: unknown
  op: 'create' | 'update'
  convidados?: readonly string[]
  meet?: boolean
  evento: { location: string | null; description: string | null }
}): boolean {
  if (args.ligadoNaConta !== true) return false
  if (args.op === 'create' && ((args.convidados?.length ?? 0) > 0 || args.meet)) return false
  return !pareceReuniaoComConvidados(args.evento)
}
