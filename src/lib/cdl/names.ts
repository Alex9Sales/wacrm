// ============================================================
// 🙋 Saudação por nome — só chama de "Oi Fulano" quando o primeiro token
// PARECE nome de pessoa. Contatos salvos como frase/negócio ("Meus Netinhos
// Queridos 🌻🩵", "Casa da Praia", "Loja do Zé") não viram "Oi Meus!".
// Pura (sem server-only) — usada no rascunho da IA (worker) e na UI.
// ============================================================

// Primeiras palavras comuns em nomes de negócio/contato que NÃO são nome de
// pessoa. Se o 1º token cair aqui, a saudação sai sem nome ("Oi!").
const NOT_A_NAME = new Set([
  'meus', 'meu', 'minha', 'minhas', 'nossa', 'nosso',
  'casa', 'loja', 'bar', 'sitio', 'sítio', 'chacara', 'chácara',
  'sr', 'sra', 'dr', 'dra', 'cliente', 'contato', 'grupo',
  'depósito', 'deposito', 'mercado', 'mercearia', 'padaria', 'oficina',
  'the', 'a', 'o', 'os', 'as', 'de', 'da', 'do',
  // Agenda de empresa B2B (GoLink 18/09: "Google Ads", "Sta Casa", "Clínica…").
  'google', 'suporte', 'financeiro', 'comercial', 'atendimento', 'empresa',
  'clinica', 'clínica', 'consultorio', 'consultório', 'laboratorio', 'laboratório',
  'studio', 'estudio', 'estúdio', 'escola', 'colegio', 'colégio', 'academia',
  'instituto', 'escritorio', 'escritório', 'farmacia', 'farmácia', 'restaurante',
  'pizzaria', 'hotel', 'pousada', 'igreja', 'condominio', 'condomínio', 'posto',
  'distribuidora', 'transportadora', 'imobiliaria', 'imobiliária', 'construtora',
  'sta', 'sto', 'santa', 'santo',
])

// Pronome de tratamento: "Dr. João Silva" vira "Dr. João" — cumprimentar o
// cliente sem o título soa íntimo demais, e só o título ("Dr.!") soa quebrado.
const TITLES: Record<string, string> = { dr: 'Dr.', dra: 'Dra.', sr: 'Sr.', sra: 'Sra.' }

// Nome curto em maiúscula só é nome se tiver vogal logo no começo (ANA, BIA,
// ZÉ, LÉO, RUI); sigla não tem (JMJ, JR, SBC, MCE).
const NAME_START = /^[^AEIOUÁÉÍÓÚÂÊÔÃÕÀÜ]?[AEIOUÁÉÍÓÚÂÊÔÃÕÀÜ]/

function personWord(w: string | undefined, shoutedName: boolean): string {
  if (!w || w.length < 2 || w.length > 20) return ''
  if (NOT_A_NAME.has(w.toLowerCase())) return ''
  if (w === w.toUpperCase()) {
    // Sigla na frente de nome de empresa ("JMJ Materiais", "RR Transportes"):
    // a palavra curta grita e o resto não.
    if (w.length <= 3 && (!shoutedName || !NAME_START.test(w))) return ''
    // Nome gritado ("FERNANDO", "ANA-CLARA") → "Fernando", "Ana-Clara".
    return w.toLowerCase().replace(/(^|-)(\p{L})/gu, (_m, s: string, c: string) => s + c.toUpperCase())
  }
  return w.charAt(0).toUpperCase() + w.slice(1)
}

/**
 * Retorna o primeiro nome usável pra saudação, ou '' quando o "nome" não
 * parece de pessoa (frase, negócio, emoji, número). Título vem junto:
 * "Dra. Ana Lima" → "Dra. Ana".
 */
export function firstNameForGreeting(name: string | null | undefined): string {
  if (!name) return ''
  // NFC: "João" colado de PDF/Mac vem decomposto (o + til separado) e o til
  // sumia ("Joa"). Fica só com letras, hífen e apóstrofo DENTRO da palavra
  // ("Ana-Clara", "D'Ávila") → descarta emoji, número, símbolo.
  const words = name
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\s'’-]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^['’-]+|['’-]+$/g, ''))
    .filter(Boolean)
  const title = TITLES[(words[0] ?? '').toLowerCase()]
  const nameWords = title ? words.slice(1) : words
  // O título não conta: "Sra. ANA" é nome gritado, igual a "ANA".
  const shouted = nameWords.every((w) => w === w.toUpperCase())
  const first = personWord(nameWords[0], shouted)
  if (title) return first ? `${title} ${first}` : ''
  return first
}

/** "Oi Fulano!" quando dá; senão "Oi!". */
export function greeting(name: string | null | undefined): string {
  const n = firstNameForGreeting(name)
  return n ? `Oi ${n}!` : 'Oi!'
}
