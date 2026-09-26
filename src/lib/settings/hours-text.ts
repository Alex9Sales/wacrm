// ============================================================
// O horário de atendimento em PORTUGUÊS, pra IA dizer ao cliente.
//
// 26/09 (Família do Gás): o Alex mudou o fechamento pra 20h em Configurações
// → Atendimento e, às 19:28, a Maria continuou dizendo "atendemos até 20h30".
// Nenhum dos dois estava errado: o horário COMERCIAL (account_settings) manda
// no aviso de fora de horário; o que a IA FALA vinha de um texto livre no
// perfil da empresa, escrito à mão meses antes e nunca mais tocado.
//
// Texto livre que duplica um dado configurado envelhece calado. Aqui ele passa
// a ser DERIVADO — e o perfil só precisa ser preenchido quando a empresa
// quiser dizer algo que a configuração não expressa ("feriados sob consulta").
// ============================================================

import type { BusinessDay } from './account-settings'

/** 0 = domingo, como em `businessDays`. */
const DIAS = [
  'Domingo',
  'Segunda',
  'Terça',
  'Quarta',
  'Quinta',
  'Sexta',
  'Sábado',
] as const

/** "08:00" → "8h" · "20:30" → "20h30". Como se fala, não como se digita. */
function hora(v: string): string {
  const [h, m] = v.split(':')
  const hh = String(Number(h))
  return m && m !== '00' ? `${hh}h${m}` : `${hh}h`
}

function aberto(d: BusinessDay | undefined): d is BusinessDay & { open: string; close: string } {
  return !!d?.open && !!d?.close
}

/**
 * Descreve a semana agrupando dias seguidos de mesmo horário:
 * "Segunda a sábado das 7h às 20h, domingo das 8h às 14h".
 *
 * Devolve null quando não há NENHUM dia aberto — nesse caso quem chama deve
 * cair no texto do perfil, em vez de afirmar que a empresa nunca abre.
 */
export function businessHoursText(days: BusinessDay[] | null | undefined): string | null {
  if (!Array.isArray(days) || days.length === 0) return null

  // Começa na segunda: "segunda a sábado" é como as pessoas leem a semana,
  // e um array que abre em domingo quebraria o agrupamento no meio.
  const ordem = [1, 2, 3, 4, 5, 6, 0]
  const blocos: { de: number; ate: number; janela: string }[] = []

  for (const i of ordem) {
    const d = days[i]
    if (!aberto(d)) continue
    const janela = `das ${hora(d.open)} às ${hora(d.close)}`
    const ultimo = blocos[blocos.length - 1]
    const seguido = ultimo && ordem.indexOf(i) === ordem.indexOf(ultimo.ate) + 1
    if (ultimo && ultimo.janela === janela && seguido) {
      ultimo.ate = i
    } else {
      blocos.push({ de: i, ate: i, janela })
    }
  }

  if (blocos.length === 0) return null

  const partes = blocos.map((b) => {
    const nome =
      b.de === b.ate
        ? DIAS[b.de]
        : `${DIAS[b.de]} a ${DIAS[b.ate].toLowerCase()}`
    return `${nome} ${b.janela}`
  })

  // Só o primeiro bloco começa maiúsculo; os demais seguem a frase.
  return partes
    .map((p, i) => (i === 0 ? p : p.charAt(0).toLowerCase() + p.slice(1)))
    .join(', ')
}
