// ============================================================
// 🦷 Em qual agenda a IA marca — quando a clínica tem vários profissionais.
//
// 30/09/2026. A clínica da Dra. Joyce reconectou o Google e apareceram as
// agendas dos 10 profissionais: Dr. André, Dra. Bruna, Dr. Igor, Dra. Juliane,
// Dr. Lucas, Dra. Letícia, Dra. Patrícia, Dra. Alessandra, Dra. Simone e
// Radiologia. Até então o CRM via uma agenda só.
//
// O Alex pediu o que o negócio precisa: "ela tem que agendar de todo mundo que
// está na agenda. Todas, da Joyce e das subagendas. Ela verifica e agenda."
//
// Duas coisas mudam de uma vez:
//
// 1. A IA marcava sempre na MESMA agenda (`aiCalendarId`, uma por conta).
// 2. A disponibilidade era da CONTA INTEIRA — um horário ocupado pela Dra.
//    Bruna deixaria os outros 9 dentistas sem aquele horário, porque a lista de
//    "horários ocupados" no prompt não dizia de quem era cada um.
//
// Este módulo é a peça pequena e testável do meio: dado o nome que a IA
// escreveu ("Dra. Bruna", "bruna diodatti", "DR. LUCAS"), descobrir de qual
// agenda ela está falando.
//
// ⚠️ A regra de ouro é a mesma do casamento por telefone: na dúvida, NÃO chuta.
// Marcar na agenda errada coloca o paciente na cadeira do dentista errado, e
// ninguém percebe até o dia da consulta. Ambíguo devolve 'ambiguo' e quem chama
// deixa cair na agenda padrão, que é onde a recepção já olha.
//
// Sem 'server-only': o worker alcança este arquivo.
// ============================================================

export type AgendaDisponivel = {
  id: string
  name: string
}

/**
 * Tira acento, pontuação, título profissional e o excesso de espaço.
 *
 * "Dra. Bruna Diodatti" e "bruna  diodatti" viram a mesma coisa. Os títulos
 * saem porque a IA escreve "Dra. Bruna" e a agenda pode se chamar só "Bruna
 * Diodatti" — ou o contrário.
 */
export function normalizarNomeDeAgenda(texto: string): string {
  return (texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.,;:()\-_/]/g, ' ')
    // Títulos: dr, dra, doutor, doutora, prof. Só como palavra inteira.
    .replace(/\b(dr|dra|doutor|doutora|prof|profa)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** As palavras do nome, sem as partículas que não identificam ninguém. */
function palavras(texto: string): string[] {
  const PARTICULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e'])
  return normalizarNomeDeAgenda(texto)
    .split(' ')
    .filter((p) => p.length > 1 && !PARTICULAS.has(p))
}

/**
 * De qual agenda a IA está falando?
 *
 * Devolve a agenda, `null` quando não reconhece nada, ou `'ambiguo'` quando
 * mais de uma poderia ser — e aí quem chama NÃO deve escolher por conta
 * própria. "Dra. Simone" com uma Simone Magalhães e uma Simone Ferreira na
 * clínica é exatamente o caso em que chutar põe o paciente na cadeira errada.
 *
 * A comparação é por palavras do nome, não por texto inteiro: a agenda pode se
 * chamar "Dra. Bruna Diodatti" e a IA escrever só "Bruna".
 */
export function escolherAgenda(
  nomeDito: string | null | undefined,
  agendas: AgendaDisponivel[],
): AgendaDisponivel | null | 'ambiguo' {
  const alvo = palavras(nomeDito ?? '')
  if (alvo.length === 0 || agendas.length === 0) return null

  // 1) Nome idêntico depois de normalizar — o caso feliz, e sem ambiguidade
  //    possível mesmo que outra agenda contenha as mesmas palavras.
  const exatas = agendas.filter(
    (a) => normalizarNomeDeAgenda(a.name) === normalizarNomeDeAgenda(nomeDito ?? ''),
  )
  if (exatas.length === 1) return exatas[0]
  if (exatas.length > 1) return 'ambiguo'

  // 2) Todas as palavras ditas aparecem no nome da agenda. "Bruna" acha
  //    "Dra. Bruna Diodatti"; "bruna diodatti" também.
  const contem = agendas.filter((a) => {
    const nome = palavras(a.name)
    return alvo.every((p) => nome.includes(p))
  })
  if (contem.length === 1) return contem[0]
  if (contem.length > 1) return 'ambiguo'

  return null
}

/**
 * O bloco que vai para o prompt: quem existe e quando cada um está ocupado.
 *
 * É o que dá à IA a informação que ela nunca teve — antes a lista de horários
 * ocupados era uma só, da conta inteira, sem dizer de quem. Com isso ela pode
 * oferecer a quarta às 10h com a Dra. Bruna mesmo que o Dr. Lucas esteja
 * ocupado nesse horário.
 */
export function blocoDeAgendasParaPrompt(
  agendas: AgendaDisponivel[],
  ocupadosPorAgenda: Map<string, string[]>,
): string {
  if (agendas.length === 0) return ''
  const linhas = agendas.map((a) => {
    const ocupados = ocupadosPorAgenda.get(a.id) ?? []
    return ocupados.length > 0
      ? `- ${a.name} — ocupado: ${ocupados.join('; ')}`
      : `- ${a.name} — sem compromissos no período`
  })
  return linhas.join('\n')
}
