// ============================================================
// 👯 O mesmo atendimento lançado em DUAS agendas.
//
// 01/10/2026. Numa clínica, a recepção lança a consulta na agenda da dona E na
// do profissional, no mesmo horário. Para o CRM são dois compromissos
// confirmados ligados ao mesmo paciente — e o motor de lembretes tratava cada
// um isoladamente: o paciente receberia o mesmo lembrete duas vezes.
//
// DUPLICADO = outro compromisso da MESMA conta, do MESMO contato, no MESMO
// instante, confirmado, com id diferente. A mesma pessoa em dois profissionais
// no mesmo minuto não existe na vida real; um segundo de diferença já é outro
// compromisso.
//
// QUEM ENVIA (o canônico): o compromisso criado PRIMEIRO no CRM; empate, o de
// menor id. Não é preferência pela agenda do profissional porque o lembrete não
// cita agenda nem profissional — o prompt usa só o horário, o template só
// {nome}/{hora}/{data} —, então a escolha não mudaria uma letra da mensagem. E o
// mais antigo é estável: uma cópia lançada depois nunca toma o lugar de quem já
// vinha enviando para repetir um degrau que já saiu.
//
// O OUTRO NÃO ENVIA. Quando o degrau dele vence:
//   - o canônico já carimbou aquele degrau → carimba também (o paciente já
//     recebeu, ou aquele degrau não tinha mais volta);
//   - o canônico ainda não carimbou → ESPERA, sem enviar e sem carimbar. Se o
//     canônico estiver travado (IA pausada, canal fora), o motivo aparece no
//     compromisso dele, e quando ele sair da fila o outro acompanha.
// Cancelado não conta: se o canônico for cancelado ou apagado, o outro vira
// canônico sozinho e o paciente continua sendo avisado.
//
// Sem 'server-only' e sem banco: roda no worker e é testado puro.
// ============================================================

/** O mínimo de um compromisso para decidir quem do grupo manda o lembrete. */
export interface CompromissoDoLembrete {
  id: string
  accountId: string
  contactId: string | null
  /** ISO ou o texto do Postgres — comparado como instante, não como texto. */
  startsAt: string
  status: string
  createdAt: string
  remindersSent: number
}

export type DecisaoDuplicado =
  /** Sem cópia, ou é o canônico: segue o fluxo normal do lembrete. */
  | 'envia'
  /** É cópia e o canônico ainda não resolveu este degrau: não envia nem carimba. */
  | 'espera'
  /** Outro compromisso do grupo já resolveu este degrau: carimba sem enviar. */
  | 'carimba'

function instante(v: string): number {
  return new Date(v).getTime()
}

/**
 * As cópias deste compromisso: o mesmo atendimento lançado em outra agenda.
 *
 * Sem contato não se aplica — bloqueio de agenda e consulta órfã não têm para
 * quem mandar, e dois bloqueios no mesmo horário não são a mesma pessoa.
 * Horário ilegível também não: na dúvida, cada um segue sozinho como antes.
 */
export function duplicadosDe(
  evento: CompromissoDoLembrete,
  outros: CompromissoDoLembrete[],
): CompromissoDoLembrete[] {
  if (!evento.contactId) return []
  const t = instante(evento.startsAt)
  if (Number.isNaN(t)) return []
  return outros.filter(
    (o) =>
      o.id !== evento.id &&
      o.accountId === evento.accountId &&
      o.contactId === evento.contactId &&
      o.status === 'confirmed' &&
      instante(o.startsAt) === t,
  )
}

function porCriacao(a: CompromissoDoLembrete, b: CompromissoDoLembrete): number {
  const ta = instante(a.createdAt)
  const tb = instante(b.createdAt)
  const na = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta
  const nb = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb
  if (na !== nb) return na < nb ? -1 : 1
  // Comparação por código, não localeCompare: o mesmo par tem que dar o mesmo
  // canônico em qualquer máquina, olhando de qualquer um dos dois lados.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** O compromisso do grupo que manda o lembrete: o criado primeiro (empate: menor id). */
export function escolherCanonico(
  grupo: CompromissoDoLembrete[],
): CompromissoDoLembrete | null {
  if (grupo.length === 0) return null
  return [...grupo].sort(porCriacao)[0]
}

/**
 * Este compromisso manda o degrau `degrau` (índice do vencido agora), espera
 * pelo canônico ou só carimba?
 *
 * `outros` pode vir mais largo que o grupo (a consulta já filtra, mas a regra
 * de quem é cópia mora aqui, em `duplicadosDe`).
 */
export function decidirLembreteDuplicado(args: {
  evento: CompromissoDoLembrete
  outros: CompromissoDoLembrete[]
  degrau: number
}): { decisao: DecisaoDuplicado; canonicoId: string | null; duplicados: string[] } {
  const { evento, degrau } = args
  const copias = duplicadosDe(evento, args.outros)
  if (copias.length === 0) return { decisao: 'envia', canonicoId: null, duplicados: [] }

  const canonico = escolherCanonico([evento, ...copias]) as CompromissoDoLembrete
  const duplicados = copias.map((c) => c.id)
  const jaResolveu = (c: CompromissoDoLembrete) => c.remindersSent > degrau

  if (canonico.id === evento.id) {
    // Canônico, mas uma cópia já resolveu este degrau: lembrete que saiu antes
    // desta regra existir, ou um canônico que voltou de um cancelamento depois
    // que a cópia assumiu. Mandar de novo seria repetir para o paciente.
    return {
      decisao: copias.some(jaResolveu) ? 'carimba' : 'envia',
      canonicoId: canonico.id,
      duplicados,
    }
  }
  return {
    decisao: jaResolveu(canonico) ? 'carimba' : 'espera',
    canonicoId: canonico.id,
    duplicados,
  }
}

/**
 * Chave do degrau de UM atendimento dentro de uma varredura:
 * conta|contato|instante|degrau. Segura o caso de as duas cópias passarem na
 * mesma varredura — a segunda vê que o degrau já saiu pela primeira.
 */
export function chaveDoDegrau(
  accountId: string,
  contactId: string,
  startsAt: string,
  degrau: number,
): string {
  return `${accountId}|${contactId}|${instante(startsAt)}|${degrau}`
}
