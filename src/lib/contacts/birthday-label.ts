// ============================================================
// 🎂 Como o aniversário aparece na tela.
//
// 23/09 (Vitor/GoLink): "peço a data pro cliente, coloco, e não grava". Gravava
// — o que faltava era VER: a ficha do atendimento não mostrava o campo em lugar
// nenhum, então salvar parecia não ter efeito.
//
// Ano 1900 é o nosso "não sei o ano" (normalizeBirthday usa isso quando o
// cliente só diz dia e mês), e nesse caso a tela mostra só dd/mm.
//
// Puro — a ficha importa direto.
// ============================================================

/** Ano que significa "só sei o dia e o mês" (ver `normalizeBirthday`). */
export const BIRTHDAY_YEAR_UNKNOWN = 1900

/** "1980-02-28" → "28/02/1980"; "1900-05-18" → "18/05"; inválido → null. */
export function birthdayLabel(raw: string | null | undefined): string | null {
  const m = (raw ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  const [, y, mes, dia] = m
  return Number(y) === BIRTHDAY_YEAR_UNKNOWN ? `${dia}/${mes}` : `${dia}/${mes}/${y}`
}

/** Quantos anos a pessoa faz na data, ou null quando o ano é desconhecido. */
export function birthdayAge(raw: string | null | undefined, hoje = new Date()): number | null {
  const m = (raw ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  const ano = Number(m[1])
  if (ano === BIRTHDAY_YEAR_UNKNOWN) return null
  let idade = hoje.getFullYear() - ano
  const passou = hoje.getMonth() + 1 > Number(m[2]) || (hoje.getMonth() + 1 === Number(m[2]) && hoje.getDate() >= Number(m[3]))
  if (!passou) idade -= 1
  return idade >= 0 && idade < 130 ? idade : null
}

/** É hoje? Compara só dia e mês, no fuso de quem olha. */
export function isBirthdayToday(raw: string | null | undefined, hoje = new Date()): boolean {
  const m = (raw ?? '').trim().match(/^\d{4}-(\d{2})-(\d{2})/)
  if (!m) return false
  return Number(m[1]) === hoje.getMonth() + 1 && Number(m[2]) === hoje.getDate()
}
