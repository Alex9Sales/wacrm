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

/**
 * - marcacao: consulta nova para este paciente;
 * - remarcacao: mudou o dia/hora;
 * - profissional (01/10, revisão): MESMO dia e hora, outro profissional. Dizer
 *   "foi remarcada" com o horário de sempre faz o paciente achar que mudou a
 *   hora — e ligar, ou faltar.
 */
export type TipoConfirmacao = 'marcacao' | 'remarcacao' | 'profissional'

/**
 * O que aconteceu com a confirmação, para a tela dizer. `null` = ninguém pediu
 * (caixa desmarcada, opção desligada, edição que não mexeu no horário).
 *
 * `incerta` (01/10, revisão): o WhatsApp demorou e a chamada caiu sem resposta.
 * A mensagem pode ter chegado — dizer "não enviada" levaria a recepção a mandar
 * de novo para quem já recebeu.
 */
export type ResultadoConfirmacao = 'enviada' | { naoEnviada: string } | { incerta: string }

export const FUSO_PADRAO = 'America/Sao_Paulo'

// ---------- Quando manda ----------

/**
 * Edição na Agenda: isso pede confirmação ao paciente? E de que tipo?
 *
 * - paciente ligado agora (não tinha, ou era outro): para ele é uma consulta
 *   NOVA → marcação;
 * - mudou o dia/hora: remarcação;
 * - mudou SÓ a agenda: 'profissional', e só quando a agenda nova é de um
 *   profissional diferente do de antes. Agenda nova genérica ("Minha agenda",
 *   o e-mail da clínica) ou o mesmo profissional em outra agenda não dizem nada
 *   de novo ao paciente → nada (01/10, revisão);
 * - mudou só título, descrição, local, fim: nada. Corrigir a grafia do título
 *   não pode virar mensagem no celular do paciente.
 *
 * `nomeAgenda` é o nome da agenda de antes/depois; sem ele, troca de agenda
 * não oferece nada (na dúvida, não manda).
 */
export function tipoDaConfirmacaoNaEdicao(args: {
  antes: { startsAt: string; calendarId: string; contactId: string | null; nomeAgenda?: string | null }
  depois: { startsAt: string; calendarId: string; contactId: string | null; nomeAgenda?: string | null }
}): TipoConfirmacao | null {
  const { antes, depois } = args
  if (!depois.contactId) return null
  if (depois.contactId !== antes.contactId) return 'marcacao'
  if (new Date(depois.startsAt).getTime() !== new Date(antes.startsAt).getTime()) return 'remarcacao'
  if (depois.calendarId !== antes.calendarId) {
    const novo = profissionalDaAgenda(depois.nomeAgenda)
    if (!novo) return null
    const velho = profissionalDaAgenda(antes.nomeAgenda)
    if (velho && semAcento(velho) === semAcento(novo)) return null
    return 'profissional'
  }
  return null
}

export type DecisaoConfirmacao = { envia: true } | { envia: false; motivo: string }

/**
 * Por que este compromisso/contato NUNCA recebe a confirmação, seja qual for
 * o horário: cancelado, grupo, "não perturbe". null = nada impede.
 *
 * Separado de `decidirConfirmacao` para o modal usar a MESMA regra (01/10,
 * revisão): a caixa "Sai ao salvar" aparecia nesses casos e o aviso depois
 * desmentia. Contato ainda não carregado (null) não impede — o servidor confere.
 */
export function impedimentoDaConfirmacao(args: {
  status: string
  contato: { isGroup: boolean; optedOut: boolean } | null
}): string | null {
  if (args.status === 'cancelled') return 'o compromisso está cancelado'
  if (args.contato?.isGroup) return 'o contato é um grupo, não uma pessoa'
  // "Não perturbe" (anti-ban, `contacts.opted_out`): quem pediu para não
  // receber mensagens não recebe mensagem automática, nem esta.
  if (args.contato?.optedOut) return 'o paciente pediu para não receber mensagens (não perturbe)'
  return null
}

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
  const impede = impedimentoDaConfirmacao({ status: evento.status, contato })
  if (impede) return { envia: false, motivo: impede }
  return { envia: true }
}

// ---------- O texto ----------

/**
 * Primeira palavra (sem acento, minúscula) que diz "isso não é uma pessoa".
 * Só vale para agenda SEM "Dr./Dra." na frente — ver `profissionalDaAgenda`.
 */
const NAO_E_PROFISSIONAL = new Set([
  'agenda', 'agendamento', 'agendamentos', 'minha', 'meu', 'calendario', 'calendar', 'google', 'principal',
  'padrao', 'geral', 'pessoal', 'trabalho', 'feriados', 'holidays', 'aniversarios',
  'birthdays', 'tarefas', 'tasks', 'bloqueio', 'bloqueios',
  // Agenda de serviço/sala, não de gente (a clínica da Dra. Joyce tem uma
  // "Radiologia"): "sua consulta com Radiologia" soa quebrado.
  'radiologia', 'raio', 'sala', 'consultorio', 'recepcao', 'clinica',
  'avaliacao', 'avaliacoes', 'exame', 'exames', 'procedimento', 'procedimentos',
  'cirurgia', 'cirurgias', 'laboratorio', 'atendimento', 'atendimentos',
  // 01/10, revisão: serviço com nome de duas palavras ("Estética Facial",
  // "Clareamento Dental", "Implantes Dentários") passava como gente.
  'implante', 'implantes', 'limpeza', 'limpezas', 'ortodontia', 'clareamento', 'clareamentos',
  'estetica', 'retorno', 'retornos', 'encaixe', 'encaixes', 'contato', 'contatos', 'familia',
  'profilaxia', 'endodontia', 'periodontia', 'protese', 'proteses', 'harmonizacao', 'odontologia',
  'odontopediatria', 'pediatria', 'dermatologia', 'fisioterapia', 'psicologia', 'nutricao',
  'consulta', 'consultas', 'manutencao', 'manutencoes', 'aparelho', 'aparelhos', 'canal',
  'extracao', 'extracoes', 'restauracao', 'tratamento', 'tratamentos', 'urgencia', 'urgencias',
  'emergencia', 'plantao', 'triagem', 'orcamento', 'orcamentos', 'tomografia', 'ultrassom',
  'laser', 'botox', 'reuniao', 'reunioes', 'evento', 'eventos', 'lembrete', 'lembretes',
])

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * O nome da agenda serve para "com {profissional}"? Cada dentista tem a sua
 * ("Dr. Igor"). Devolve o trecho pronto para depois de "com" — com o artigo
 * quando há título ("o Dr. Igor Talamoni", "a Dra. Leticia Ghilardi") — ou
 * null quando não dá para afirmar que é gente.
 *
 * 01/10, revisão: era uma lista do que NÃO é gente, e "Implantes", "Limpeza",
 * "Ortodontia" passavam ("Sua consulta com Implantes"). Agora a regra é
 * positiva — só cita quando o nome:
 *   1. começa por Dr/Dra (com ou sem ponto) → com artigo; ou
 *   2. é nome e sobrenome de gente (firstNameForGreeting aceita a primeira
 *      palavra, há pelo menos duas palavras, nenhuma com número, e a primeira
 *      não é serviço/sala) → sem artigo ("com Leticia Ghilardi").
 * Uma palavra só ("Implantes", "Fulana") fica de fora: agenda com um nome só é
 * muito mais vezes serviço do que gente. Na dúvida fica sem: "Sua consulta
 * está confirmada" é sempre verdade; "com Radiologia" não é gente.
 */
export function profissionalDaAgenda(nome: string | null | undefined): string | null {
  let n = (nome ?? '').replace(/\s+/g, ' ').trim()
  if (!n || n.includes('@')) return null
  // "Agenda do Dr. Igor", "Agenda - Letícia", "Agenda Dr. Igor" → o que vem depois.
  n = n.replace(/^agenda(?:\s*[-–:|]\s*|\s+d[aoe]s?\s+|\s+)/i, '').trim()
  if (!n) return null

  // 1. "Dr. Igor Talamoni", "Dra Leticia" → "o Dr. Igor Talamoni", "a Dra. Leticia".
  const titulo = /^(dra|dr)\b\.?\s*(.*)$/i.exec(n)
  if (titulo) {
    const resto = (titulo[2] ?? '').trim()
    if (!/\p{L}/u.test(resto)) return null // "Dr." sozinho não é ninguém
    return titulo[1].toLowerCase() === 'dra' ? `a Dra. ${resto}` : `o Dr. ${resto}`
  }

  // 2. Nome e sobrenome de gente, sem título.
  const palavras = n.split(' ')
  if (palavras.length < 2 || /\d/.test(n)) return null
  const primeira = semAcento(palavras[0] ?? '').replace(/[^a-z]/g, '')
  if (!primeira || NAO_E_PROFISSIONAL.has(primeira)) return null
  if (!firstNameForGreeting(n)) return null
  return n
}

/**
 * Perfil do WhatsApp não é nome: é como a pessoa se apresenta para os amigos.
 * "Mãe", "Amor", "Deus é fiel" passam no firstNameForGreeting e virariam
 * "Olá, Mãe!" numa mensagem da clínica (01/10, revisão). Lista curta de
 * propósito: só o que aparece em perfil e nunca é nome de gente.
 */
const APELIDO_DE_PERFIL = new Set([
  'mae', 'mamae', 'mainha', 'pai', 'papai', 'painho', 'amor', 'amore', 'mozao', 'mor', 'vida',
  'deus', 'jesus', 'cristo', 'senhor', 'senhora', 'fe', 'fiel', 'bencao', 'gratidao', 'paz', 'luz',
  'bebe', 'baby', 'gatinha', 'gatinho', 'gata', 'gato', 'princesa', 'principe', 'rainha', 'rei',
  'anjo', 'anjinho', 'anjinha', 'linda', 'lindo', 'eu', 'familia', 'vo', 'vovo', 'avo', 'tia', 'tio',
  'irma', 'irmao', 'filha', 'filho', 'esposa', 'esposo', 'marido',
])

/**
 * O primeiro nome da saudação, ou '' para "Olá!". Regra dos disparos
 * (firstNameForGreeting) e, para nome que veio do PERFIL do WhatsApp
 * (`contacts.name_source = 'whatsapp'`), também a lista de apelidos acima.
 * Nome digitado no CRM ou da agenda do celular é decisão de gente: vale.
 */
export function nomeParaSaudacao(nome: string | null | undefined, nameSource?: string | null): string {
  const primeiro = firstNameForGreeting(nome)
  if (!primeiro || nameSource !== 'whatsapp') return primeiro
  // "Dra. Ana" → olha o "Ana", não o título.
  const palavra = primeiro.split(' ').pop() ?? ''
  return APELIDO_DE_PERFIL.has(semAcento(palavra)) ? '' : primeiro
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
 * como prévia. "Sua consulta com o Dr. Igor está confirmada para …."
 */
export function fraseDaConsulta(args: {
  tipo: TipoConfirmacao
  nomeAgenda: string | null | undefined
  startsAt: string
  allDay: boolean
  tz: string
}): string {
  const prof = profissionalDaAgenda(args.nomeAgenda)
  const quando = quandoDaConsulta(args)
  // Só trocou o profissional (01/10, revisão): o horário é o MESMO, então a
  // frase o repete como referência e diz o que mudou — nunca "remarcada".
  if (args.tipo === 'profissional' && prof) return `Sua consulta de ${quando}, agora é com ${prof}.`
  const com = prof ? ` com ${prof}` : ''
  const verbo = args.tipo === 'remarcacao' ? 'foi remarcada para' : 'está confirmada para'
  return `Sua consulta${com} ${verbo} ${quando}.`
}

/** A mensagem inteira que o paciente recebe. */
export function textoDaConfirmacao(args: {
  tipo: TipoConfirmacao
  nomeContato: string | null | undefined
  /** `contacts.name_source`: 'whatsapp' = nome do perfil (ver nomeParaSaudacao). */
  nameSource?: string | null
  nomeAgenda: string | null | undefined
  startsAt: string
  allDay: boolean
  tz: string
}): string {
  // Mesma regra dos disparos: só chama pelo nome quando parece nome de gente
  // ("Dra. Ana", "Ana"); emoji, número, nome de empresa ou apelido de perfil
  // ("Mãe", "Deus é fiel") viram "Olá!".
  const nome = nomeParaSaudacao(args.nomeContato, args.nameSource)
  const ola = nome ? `Olá, ${nome}!` : 'Olá!'
  return `${ola} ${fraseDaConsulta(args)} Qualquer dúvida, é só responder por aqui.`
}
