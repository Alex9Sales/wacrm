// ============================================================
// 🩺 Com quem é a consulta — o profissional do lembrete de consulta.
//
// 02/10/2026. Numa clínica com doze agendas do Google (uma por profissional),
// o lembrete da véspera é escrito pela IA, e a varredura não dizia a ela de
// QUAL agenda era o compromisso. A instrução da conta falava em "clínica da
// Dra. <dona>" e um paciente de outro dentista entendeu que a consulta era com
// a dona. O modo template só tinha {nome}, {hora} e {data}.
//
// Agora a varredura traz o nome da agenda de cada compromisso do GRUPO (o
// mesmo atendimento em agendas diferentes — meeting-reminder-dedup.ts) e daqui
// sai UM profissional, ou nenhum:
//   - nome de agenda só vira profissional por `profissionalDaAgenda` (com
//     título Dr./Dra., nunca setor ou exame como "DR. RADIOLOGIA");
//   - havendo alguma SUBAGENDA no grupo, só elas contam: o mesmo evento do
//     Google aparece na agenda principal da conta conectada (a da dona, como
//     convidada) E na do profissional, e quem atende é o da subagenda. Se a
//     subagenda é de um setor, ninguém é citado — a dona não vira a resposta;
//   - dois profissionais diferentes (irmãos no mesmo horário com dentistas
//     diferentes, contato compartilhado): ninguém. Citar um seria mentir para
//     o outro;
//   - o mesmo profissional escrito de dois jeitos ("Dr. Igor" × "Dr. Igor
//     Talamoni"): ele, com o nome mais completo.
// Na dúvida, sem profissional.
//
// Quem ENVIA o lembrete continua sendo o canônico (o criado primeiro); o
// profissional é do atendimento, então sai do grupo inteiro.
//
// "Não cite profissional" (o fato sem profissional) só vale numa conta com
// VÁRIAS AGENDAS DE PROFISSIONAL — duas ou mais agendas cujo nome passa em
// `profissionalDaAgenda` (02/10, revisão). Antes bastava a conta ter duas
// agendas quaisquer: uma franquia com seis agendas do Google sem "Dr." no nome
// recebia "não cite nenhum profissional, nem o da instrução do operador; chame
// só de 'sua consulta'" — calava o nome que o operador mandou citar e chamava
// reunião comercial de consulta. Sem agenda de profissional não há de quem
// errar: o prompt fica como era antes.
//
// Sem 'server-only' e sem banco: roda no worker e é testado puro.
// ============================================================

import { mesmoProfissional, profissionalDaAgenda } from '@/lib/agenda/confirmacao-agendamento'

/** A agenda de um compromisso do grupo, como a varredura lê do banco. */
export interface AgendaDoCompromisso {
  /** `calendars.name`. */
  nome: string | null
  /**
   * É a agenda PRINCIPAL de uma conta Google conectada nesta conta do CRM
   * (google_calendar_id = e-mail da conexão) — numa clínica, a da dona.
   */
  principal: boolean
}

/**
 * O profissional do atendimento ("o Dr. Igor Talamoni", "a Dra. Fulana"), ou
 * null quando não dá para afirmar. Ver o cabeçalho.
 */
export function profissionalDoLembrete(agendas: AgendaDoCompromisso[]): string | null {
  const subagendas = agendas.filter((a) => !a.principal)
  const consideradas = subagendas.length > 0 ? subagendas : agendas
  const nomes = consideradas
    .map((a) => profissionalDaAgenda(a.nome))
    .filter((p): p is string => p !== null)
  if (nomes.length === 0) return null
  // O nome mais completo; empate, a ordem de código (o mesmo grupo dá sempre
  // o mesmo texto, em qualquer cópia que envie).
  const maisCompleto = [...nomes].sort(
    (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
  )[0]
  return nomes.every((n) => mesmoProfissional(n, maisCompleto)) ? maisCompleto : null
}

/**
 * A conta tem VÁRIAS AGENDAS DE PROFISSIONAL? Duas ou mais agendas cujo nome
 * vira profissional em `profissionalDaAgenda` ("Dr. Igor", "Agenda da Dra.
 * Ana"). É só aí que um lembrete sem profissional pode citar a pessoa errada
 * (o caso da dona). Agendas de equipe, de setor ou de sala ("Comercial",
 * "Franquias SP", "DR. RADIOLOGIA") não contam — ver o cabeçalho.
 */
export function contaComVariosProfissionais(nomesDasAgendas: (string | null | undefined)[]): boolean {
  let n = 0
  for (const nome of nomesDasAgendas) {
    if (profissionalDaAgenda(nome) && ++n >= 2) return true
  }
  return false
}

/**
 * O FATO que entra no prompt do lembrete, como contexto do sistema — o texto
 * do operador não muda. Com profissional: diz com quem é, e que esse nome vale
 * mais que qualquer outro do texto do operador ou do perfil. Sem profissional,
 * numa conta com VÁRIAS AGENDAS DE PROFISSIONAL (`contaComVariosProfissionais`):
 * não citar ninguém (citar seria chute — foi o caso da dona). Qualquer outra
 * conta: null, nada muda — lá não há de quem errar, e o operador pode ter
 * escrito com quem é a reunião (esse nome tem que continuar valendo).
 *
 * O compromisso é chamado com a palavra que a conversa já usa (02/10,
 * revisão): "sua consulta" fixo virava "consulta" uma reunião comercial.
 */
export function fatoDoProfissional(
  profissional: string | null,
  contaComVariosProfissionais: boolean,
): string | null {
  if (profissional) {
    return (
      'Appointment fact (from the calendar; it overrides any professional named in the operator guidance or the business profile): ' +
      `A consulta é com ${profissional}. ` +
      `Say who the appointment is with, using exactly this name ("${profissional}"); ` +
      'never say or imply that it is with anyone else — a person named in the business name or in the guidance is not who attends this appointment.'
    )
  }
  if (!contaComVariosProfissionais) return null
  return (
    'Appointment fact (from the calendar): this business has several professionals, and the calendar does not say which one attends this appointment. ' +
    'Não cite profissional: do NOT name or imply any doctor, dentist or other professional as the one the appointment is with ' +
    '(no "com o Dr./a Dra. …") — not even one named in the operator guidance, the business profile or the business name. ' +
    'Refer to it only as the appointment, using the same word the conversation already uses.'
  )
}
