// ============================================================
// ✅ Confirmação na hora de agendar — a parte pura (decisão + texto).
//
// 01/10/2026, pedido da Dra. Joyce (clínica odontológica): "No momento que eu
// fiz o agendamento dele, ele recebe: sua consulta ficou para tal data, tal
// horário." Muita gente sai da recepção dizendo "manda no WhatsApp, que eu
// ponho na minha agenda". Antes disso, uma paciente remarcada pela recepção
// perguntou "eu não recebi o aviso de alteração ainda" — então vale também
// para a REMARCAÇÃO.
//
// Até aqui só existiam os lembretes (24h antes e no dia, `lib/ai/followup.ts`).
// Salvar na Agenda não mandava nada, e o modal ainda dizia que mandava.
//
// Este arquivo não fala com banco nem com WhatsApp: decide SE manda e monta O
// QUE manda. Quem envia é `confirmacao-envio.ts`. Sem 'server-only': o modal
// da Agenda usa `fraseDaConsulta` para mostrar o que vai sair.
//
// Texto fixo, sem IA: confirmação de horário não pode sair com o dia errado
// porque um modelo resolveu reescrever a data.
// ============================================================

import { firstNameForGreeting } from '@/lib/cdl/names'

export type TipoConfirmacao = 'marcacao' | 'remarcacao'

/**
 * O que aconteceu com a confirmação, para a tela dizer. `null` = ninguém pediu
 * (caixa desmarcada, opção desligada, edição que não mexeu no horário).
 */
export type ResultadoConfirmacao = 'enviada' | { naoEnviada: string }

export const FUSO_PADRAO = 'America/Sao_Paulo'

// ---------- Quando manda ----------

/**
 * Edição na Agenda: isso pede confirmação ao paciente? E de que tipo?
 *
 * - paciente ligado agora (não tinha, ou era outro): para ele é uma consulta
 *   NOVA → marcação;
 * - mudou o dia/hora, ou a agenda (o profissional): remarcação;
 * - mudou só título, descrição, local, fim: nada. Corrigir a grafia do título
 *   não pode virar mensagem no celular do paciente.
 */
export function tipoDaConfirmacaoNaEdicao(args: {
  antes: { startsAt: string; calendarId: string; contactId: string | null }
  depois: { startsAt: string; calendarId: string; contactId: string | null }
}): TipoConfirmacao | null {
  const { antes, depois } = args
  if (!depois.contactId) return null
  if (depois.contactId !== antes.contactId) return 'marcacao'
  if (new Date(depois.startsAt).getTime() !== new Date(antes.startsAt).getTime()) return 'remarcacao'
  if (depois.calendarId !== antes.calendarId) return 'remarcacao'
  return null
}

export type DecisaoConfirmacao = { envia: true } | { envia: false; motivo: string }

/**
 * O compromisso (já gravado) pode receber a confirmação? `motivo` é para gente
 * ler no aviso do modal: completa "Confirmação não enviada: …".
 */
export function decidirConfirmacao(args: {
  evento: {
    status: string
    startsAt: string
    endsAt: string
    allDay: boolean
    contactId: string | null
  }
  contato: { isGroup: boolean; optedOut: boolean } | null
  agora: Date
}): DecisaoConfirmacao {
  const { evento, contato, agora } = args
  if (!evento.contactId || !contato) {
    return { envia: false, motivo: 'o compromisso não tem paciente ligado' }
  }
  if (evento.status === 'cancelled') {
    return { envia: false, motivo: 'o compromisso está cancelado' }
  }
  // Dia inteiro vale até o fim do dia; com hora, até começar. "Sua consulta
  // está confirmada para ontem" é pior do que não mandar nada.
  const limite = new Date(evento.allDay ? evento.endsAt : evento.startsAt).getTime()
  if (!Number.isFinite(limite) || limite <= agora.getTime()) {
    return { envia: false, motivo: 'o horário do compromisso já passou' }
  }
  if (contato.isGroup) {
    return { envia: false, motivo: 'o contato é um grupo, não uma pessoa' }
  }
  // "Não perturbe" (anti-ban, `contacts.opted_out`): quem pediu para não
  // receber mensagens não recebe mensagem automática, nem esta.
  if (contato.optedOut) {
    return { envia: false, motivo: 'o paciente pediu para não receber mensagens (não perturbe)' }
  }
  return { envia: true }
}

// ---------- O texto ----------

/** Primeira palavra (sem acento, minúscula) que diz "isso não é uma pessoa". */
const NAO_E_PROFISSIONAL = new Set([
  'agenda', 'agendamento', 'agendamentos', 'minha', 'meu', 'calendario', 'calendar', 'google', 'principal',
  'padrao', 'geral', 'pessoal', 'trabalho', 'feriados', 'holidays', 'aniversarios',
  'birthdays', 'tarefas', 'tasks', 'bloqueio', 'bloqueios',
  // Agenda de serviço/sala, não de gente (a clínica da Dra. Joyce tem uma
  // "Radiologia"): "sua consulta com Radiologia" soa quebrado.
  'radiologia', 'raio', 'sala', 'consultorio', 'recepcao', 'clinica',
  'avaliacao', 'avaliacoes', 'exame', 'exames', 'procedimento', 'procedimentos',
  'cirurgia', 'cirurgias', 'laboratorio', 'atendimento', 'atendimentos',
])

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * O nome da agenda serve para "com {profissional}"? Cada dentista tem a sua
 * ("Dr. Igor"). Devolve o nome limpo, ou null quando é genérico —
 * e-mail (a agenda principal do Google tem o e-mail como nome), "Minha
 * agenda", "Google", vazio, sala/serviço. Na dúvida fica sem: "Sua consulta
 * está confirmada" é sempre verdade; "com Radiologia" não é gente.
 */
export function profissionalDaAgenda(nome: string | null | undefined): string | null {
  let n = (nome ?? '').replace(/\s+/g, ' ').trim()
  if (!n || n.includes('@')) return null
  // "Agenda do Dr. Igor", "Agenda - Letícia", "Agenda Dr. Igor" → o que vem depois.
  n = n.replace(/^agenda(?:\s*[-–:|]\s*|\s+d[aoe]s?\s+|\s+)/i, '').trim()
  if (!n) return null
  const primeira = semAcento(n.split(' ')[0] ?? '').replace(/[^a-z]/g, '')
  if (!primeira || NAO_E_PROFISSIONAL.has(primeira)) return null
  // Sem nenhuma letra (só número/emoji) não é nome de ninguém.
  if (!/\p{L}/u.test(n)) return null
  return n
}

function partes(d: Date, tz: string): Record<string, string> {
  const fmt = (zona: string) =>
    new Intl.DateTimeFormat('pt-BR', {
      timeZone: zona,
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      // h23: meia-noite é "00", nunca "24" (o ICU de alguns Node devolve 24).
      hourCycle: 'h23',
    }).formatToParts(d)
  let ps: Intl.DateTimeFormatPart[]
  try {
    ps = fmt(tz || FUSO_PADRAO)
  } catch {
    // Fuso inválido gravado na conta: não derruba a confirmação.
    ps = fmt(FUSO_PADRAO)
  }
  const out: Record<string, string> = {}
  for (const p of ps) out[p.type] = p.value
  return out
}

/**
 * "quinta-feira, 08/10/2026, às 14h" (ou "às 14h30") no fuso da conta.
 * Dia inteiro: "quinta-feira, 08/10/2026", sem hora.
 */
export function quandoDaConsulta(args: { startsAt: string; allDay: boolean; tz: string }): string {
  const inicio = new Date(args.startsAt)
  // Dia inteiro nasce à meia-noite do navegador de quem marcou (ou do fuso da
  // conta, no import do Google). Ler ao meio-dia dá o mesmo dia em qualquer
  // fuso razoável; ler à meia-noite podia virar o dia anterior.
  const ref = args.allDay ? new Date(inicio.getTime() + 12 * 3_600_000) : inicio
  const p = partes(ref, args.tz)
  const data = `${p.weekday}, ${p.day}/${p.month}/${p.year}`
  if (args.allDay) return data
  const min = p.minute && p.minute !== '00' ? p.minute : ''
  return `${data}, às ${Number(p.hour)}h${min}`
}

/**
 * O miolo da mensagem, sem saudação nem despedida — é o que o modal mostra
 * como prévia. "Sua consulta com Dr. Igor está confirmada para …."
 */
export function fraseDaConsulta(args: {
  tipo: TipoConfirmacao
  nomeAgenda: string | null | undefined
  startsAt: string
  allDay: boolean
  tz: string
}): string {
  const prof = profissionalDaAgenda(args.nomeAgenda)
  const com = prof ? ` com ${prof}` : ''
  const verbo = args.tipo === 'remarcacao' ? 'foi remarcada para' : 'está confirmada para'
  return `Sua consulta${com} ${verbo} ${quandoDaConsulta(args)}.`
}

/** A mensagem inteira que o paciente recebe. */
export function textoDaConfirmacao(args: {
  tipo: TipoConfirmacao
  nomeContato: string | null | undefined
  nomeAgenda: string | null | undefined
  startsAt: string
  allDay: boolean
  tz: string
}): string {
  // Mesma regra dos disparos: só chama pelo nome quando parece nome de gente
  // ("Dra. Ana", "Ana"); emoji, número ou nome de empresa viram "Olá!".
  const nome = firstNameForGreeting(args.nomeContato)
  const ola = nome ? `Olá, ${nome}!` : 'Olá!'
  return `${ola} ${fraseDaConsulta(args)} Qualquer dúvida, é só responder por aqui.`
}
