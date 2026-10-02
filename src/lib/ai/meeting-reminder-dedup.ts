// ============================================================
// 👯 O mesmo atendimento lançado em DUAS agendas.
//
// 01/10/2026. Numa clínica, a recepção lança a consulta na agenda da dona E na
// do profissional, no mesmo horário. Para o CRM são dois compromissos
// confirmados ligados ao mesmo paciente — e o motor de lembretes tratava cada
// um isoladamente: o paciente receberia o mesmo lembrete duas vezes.
//
// DUPLICADO = outro compromisso da MESMA conta, do MESMO CONTATO, no MESMO
// instante, confirmado, com id diferente. A regra é por contato, não por
// pessoa: quem recebe o lembrete é o número do contato, e é ele que não pode
// receber o mesmo aviso duas vezes. Um segundo de diferença já é outro
// compromisso.
//
// ⚠️ Contato compartilhado (pediatria): o evento do Capim é ligado pelo
// telefone da descrição, que é o do RESPONSÁVEL. Dois irmãos no mesmo horário
// com profissionais diferentes viram um grupo só e sai UM lembrete — de
// propósito: o responsável fica avisado do horário. Desde 02/10 o lembrete diz
// com quem é a consulta, e com dois profissionais diferentes no grupo ele não
// cita nenhum (meeting-reminder-profissional.ts). Consultas do mesmo contato em
// horários diferentes, mesmo no mesmo dia, NÃO são agrupadas.
//
// QUEM ENVIA (o canônico): o compromisso criado PRIMEIRO no CRM; empate, o de
// menor id. O mais antigo é estável: uma cópia lançada depois nunca toma o
// lugar de quem já vinha enviando para repetir um degrau que já saiu. Não é
// preferência pela agenda do profissional porque QUEM envia não muda o texto:
// desde 02/10 o profissional citado sai do GRUPO inteiro (a subagenda do
// profissional vence a agenda principal da dona — profissionalDoCompromisso em
// followup.ts), seja qual for a cópia que manda. A fila do worker ordena
// pelo MESMO critério (ver MEETING_QUEUE_ORDER em followup.ts), para o canônico
// passar antes das cópias.
//
// AS CÓPIAS, quando o degrau delas vence:
//   - alguém do grupo resolveu o degrau LIMPO (a mensagem saiu, ou não cabia:
//     SILENT, etapa, a hora passou) → carimba também. Quem resolve já carimba
//     o grupo inteiro na hora (followup.ts), então isto é a rede de segurança;
//   - o canônico ainda não tentou → ESPERA, sem enviar e sem carimbar;
//   - o canônico está TRAVADO (reminder_block) na MESMA conversa da cópia →
//     ESPELHA o motivo: a recepção olha a agenda do profissional, que costuma
//     ser a cópia, e o aviso "este contato não vai receber" tem que aparecer
//     lá também. Se o canônico já ENCERROU o degrau travado, a cópia encerra
//     junto, mantendo o motivo — carimbar limpo diria que o paciente foi
//     avisado quando não foi;
//   - o canônico está travado numa conversa DIFERENTE da cópia (o evento da IA
//     usa a conversa do negócio; o lançado pela recepção, a mais recente do
//     contato) → a cópia ASSUME: o problema é da conversa dele, não do
//     paciente, e por outra conversa o aviso sai. Com várias cópias, assume a
//     primeira (mesmo critério) entre as que estão numa conversa que ainda não
//     travou, e as outras acompanham ESSA.
// Cancelado não conta: se o canônico for cancelado ou apagado, o outro vira
// canônico sozinho e o paciente continua sendo avisado.
//
// Sem 'server-only' e sem banco: roda no worker e é testado puro.
// ============================================================

import type { MeetingReminderBlock } from './meeting-reminder-block'

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
  /** Por que o último degrau deste compromisso não saiu (null = nada travado). */
  reminderBlock: MeetingReminderBlock | null
  /**
   * A conversa por onde ESTE compromisso mandaria: a do negócio, senão a mais
   * recente do contato — o mesmo COALESCE da varredura.
   */
  conversationId: string | null
}

export type DecisaoDuplicado =
  /** Sem cópia, é o canônico, ou assumiu no lugar dele: segue o fluxo normal. */
  | 'envia'
  /** Quem responde pelo degrau ainda não tentou: não envia nem carimba. */
  | 'espera'
  /** Quem responde pelo degrau travou NESTA conversa: guarda o mesmo motivo. */
  | 'espelha'
  /** Outro compromisso do grupo já resolveu este degrau: carimba sem enviar. */
  | 'carimba'

export interface ResultadoDuplicado {
  decisao: DecisaoDuplicado
  /** O primeiro do grupo; null quando não há cópia. */
  canonicoId: string | null
  /**
   * Quem responde pelo degrau do ponto de vista deste compromisso: o canônico,
   * quem assumiu numa conversa que ainda não travou, ou quem já resolveu.
   */
  responsavelId: string | null
  duplicados: string[]
  /** Só em 'espelha': o motivo a gravar neste compromisso. */
  motivo: MeetingReminderBlock | null
  /** Só em 'espelha': o responsável já encerrou o degrau — este encerra junto. */
  encerra: boolean
}

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

/**
 * Criado primeiro; empate, menor id.
 *
 * `new Date` corta o created_at do Postgres (microssegundos) no milissegundo,
 * e a fila do worker faz o mesmo com date_trunc('milliseconds') — senão dois
 * compromissos criados no mesmo milissegundo teriam um canônico aqui e outra
 * ordem lá.
 */
function porCriacao(a: CompromissoDoLembrete, b: CompromissoDoLembrete): number {
  const ta = instante(a.createdAt)
  const tb = instante(b.createdAt)
  const na = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta
  const nb = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb
  if (na !== nb) return na < nb ? -1 : 1
  // Comparação por código, não localeCompare: o mesmo par tem que dar o mesmo
  // canônico em qualquer máquina, olhando de qualquer um dos dois lados. É a
  // ordem do COLLATE "C" que a fila usa.
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
 * Este compromisso manda o degrau `degrau` (índice do vencido agora), espera,
 * espelha o motivo de quem travou ou só carimba?
 *
 * `outros` pode vir mais largo que o grupo (a consulta já filtra, mas a regra
 * de quem é cópia mora aqui, em `duplicadosDe`).
 */
export function decidirLembreteDuplicado(args: {
  evento: CompromissoDoLembrete
  outros: CompromissoDoLembrete[]
  degrau: number
}): ResultadoDuplicado {
  const { evento, degrau } = args
  const copias = duplicadosDe(evento, args.outros)
  const base = { duplicados: copias.map((c) => c.id), motivo: null, encerra: false }
  if (copias.length === 0) {
    return { decisao: 'envia', canonicoId: null, responsavelId: null, ...base }
  }

  const grupo = [evento, ...copias]
  const canonico = escolherCanonico(grupo) as CompromissoDoLembrete
  const canonicoId = canonico.id

  // Resolvido LIMPO = o degrau avançou sem motivo guardado: a mensagem saiu, ou
  // não cabia (SILENT, etapa, a hora passou). Quem ENCERROU travado também
  // avança o degrau, mas guarda o motivo — não avisou ninguém e não conta.
  const resolveuLimpo = (c: CompromissoDoLembrete) => c.remindersSent > degrau && !c.reminderBlock
  const quemResolveu = escolherCanonico(copias.filter(resolveuLimpo))
  if (quemResolveu) {
    // Vale também para o canônico: lembrete que saiu pela cópia antes desta
    // regra existir, ou um canônico que voltou de um cancelamento depois que a
    // cópia assumiu. Mandar de novo seria repetir para o paciente.
    return { decisao: 'carimba', canonicoId, responsavelId: quemResolveu.id, ...base }
  }

  // Quem responde pelo degrau começa no canônico. Se ele travou, a vez passa
  // para o primeiro do grupo numa conversa que AINDA NÃO travou — até chegar
  // neste compromisso (que então assume) ou na conversa dele (que então espelha).
  const conversasTravadas = new Set<string | null>()
  let responsavel = canonico
  for (;;) {
    if (responsavel.id === evento.id) {
      return { decisao: 'envia', canonicoId, responsavelId: evento.id, ...base }
    }
    if (!responsavel.reminderBlock) {
      return { decisao: 'espera', canonicoId, responsavelId: responsavel.id, ...base }
    }
    conversasTravadas.add(responsavel.conversationId)
    if (!evento.conversationId || conversasTravadas.has(evento.conversationId)) {
      return {
        decisao: 'espelha',
        canonicoId,
        responsavelId: responsavel.id,
        duplicados: base.duplicados,
        motivo: responsavel.reminderBlock,
        encerra: responsavel.remindersSent > degrau,
      }
    }
    // A conversa deste compromisso ainda não travou, então ele é candidato e o
    // próximo sempre existe; cada volta trava uma conversa nova, então termina.
    responsavel = escolherCanonico(
      grupo.filter((c) => !!c.conversationId && !conversasTravadas.has(c.conversationId)),
    ) as CompromissoDoLembrete
  }
}

/**
 * Chave do degrau de UM atendimento dentro de uma varredura:
 * conta|contato|instante|degrau. Segura o caso de as duas cópias passarem na
 * mesma varredura — a segunda vê que o degrau já foi resolvido pela primeira.
 */
export function chaveDoDegrau(
  accountId: string,
  contactId: string,
  startsAt: string,
  degrau: number,
): string {
  return `${accountId}|${contactId}|${instante(startsAt)}|${degrau}`
}
