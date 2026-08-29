// ============================================================
// 🙋 Saudação por nome — só chama de "Oi Fulano" quando o primeiro token
// PARECE nome de pessoa. Contatos salvos como frase/negócio ("Meus Filhos
// Minha Vida 💙🩷", "Casa da Sogra", "Loja do Zé") não viram "Oi Meus!".
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
])

/**
 * Retorna o primeiro nome usável pra saudação, ou '' quando o "nome" não
 * parece de pessoa (frase, negócio, emoji, número).
 */
export function firstNameForGreeting(name: string | null | undefined): string {
  if (!name) return ''
  // Fica só com letras (com acento) e espaços → descarta emoji, número, símbolo.
  const cleaned = name.replace(/[^\p{L}\s]/gu, ' ').trim()
  const first = cleaned.split(/\s+/)[0] || ''
  if (first.length < 2 || first.length > 20) return ''
  if (NOT_A_NAME.has(first.toLowerCase())) return ''
  return first.charAt(0).toUpperCase() + first.slice(1)
}

/** "Oi Fulano!" quando dá; senão "Oi!". */
export function greeting(name: string | null | undefined): string {
  const n = firstNameForGreeting(name)
  return n ? `Oi ${n}!` : 'Oi!'
}
