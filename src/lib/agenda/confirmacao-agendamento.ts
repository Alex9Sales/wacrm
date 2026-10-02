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
//
// 02/10/2026 — a confirmação deixou de sair na hora do "Salvar". Nas primeiras
// horas em produção, um compromisso criado no horário errado e corrigido em
// seguida mandou três mensagens seguidas ao paciente ("confirmada às 18h",
// "remarcada para 18h30", outra). Agora o salvar só põe na FILA
// (`confirmacao-fila.ts`); o worker espera ATRASO_DA_CONFIRMACAO_MS depois do
// último salvar e manda só a versão final, comparada com o que o paciente já
// sabe (`confirmation_known`, migração 0204). A parte pura dessa fila — o que
// mandar, o que o paciente já sabe, o que a tela diz — também mora aqui.
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

/**
 * O que o modal diz depois de salvar (02/10). Com a fila, o salvar não envia
 * mais nada: devolve `{ agendada }` (ISO de quando sai), `{ naoEnviada }` (o
 * que já dá para saber na hora — sem paciente, horário passado, "não
 * perturbe") ou `{ descartada }` (a caixa foi desmarcada e havia uma na fila).
 * 'enviada'/`incerta` continuam no tipo: é o mesmo aviso, vindo de quem ainda
 * manda na hora. `null` = nada a dizer.
 *
 * `semCaixa` (02/10, revisão): a caixa NÃO estava na tela, mas o servidor
 * conferiu o que o paciente sabe de verdade e pôs na fila mesmo assim — a
 * grade da tela estava velha (ver conferirEdicaoSemCaixa). O aviso explica e
 * diz como desistir.
 */
export type ConfirmacaoNaTela =
  | ResultadoConfirmacao
  | { agendada: string; semCaixa?: true }
  | { descartada: true }
  | null

/**
 * O WhatsApp demorou / respondeu sem o id: ninguém sabe se o paciente recebeu.
 * Mora aqui (02/10, revisão) porque a fila também usa: a tentativa anterior
 * que morreu no meio do envio fecha com este mesmo motivo.
 */
export const MOTIVO_INCERTO = 'não deu para confirmar se a mensagem saiu; confira a conversa antes de reenviar'

export const FUSO_PADRAO = 'America/Sao_Paulo'

/** Mesmo minuto? A mensagem só diz hora e minuto ("às 14h30"). */
function mesmoMinuto(a: string, b: string): boolean {
  return Math.floor(new Date(a).getTime() / 60_000) === Math.floor(new Date(b).getTime() / 60_000)
}

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
 *
 * O horário é comparado no MINUTO (02/10): o worker compara o que o paciente
 * já sabe (gravado do banco) com o estado final, e um evento do Google com
 * segundos, regravado pelo modal sem eles, viraria "foi remarcada para" o
 * mesmo horário.
 */
export function tipoDaConfirmacaoNaEdicao(args: {
  antes: { startsAt: string; calendarId: string; contactId: string | null; nomeAgenda?: string | null }
  depois: { startsAt: string; calendarId: string; contactId: string | null; nomeAgenda?: string | null }
}): TipoConfirmacao | null {
  const { antes, depois } = args
  if (!depois.contactId) return null
  if (depois.contactId !== antes.contactId) return 'marcacao'
  if (!mesmoMinuto(depois.startsAt, antes.startsAt)) return 'remarcacao'
  if (depois.calendarId !== antes.calendarId) {
    const novo = profissionalDaAgenda(depois.nomeAgenda)
    if (!novo) return null
    const velho = profissionalDaAgenda(antes.nomeAgenda)
    if (velho && mesmoProfissional(velho, novo)) return null
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

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * Setor, exame ou sala — nunca nome de gente, mesmo depois de "Dr." (02/10).
 * Numa clínica com uma agenda do Google por profissional, a do setor de
 * imagem se chamava "DR. RADIOLOGIA": o título fazia ela passar por gente, e o
 * lembrete diria ao paciente "sua consulta com o Dr. RADIOLOGIA". Comparada
 * sem acento e sem caixa, palavra por palavra ("Raio-X" → "raio", "x"). A
 * lista pode errar para MAIS: na dúvida a mensagem fica sem profissional.
 */
const SETOR_NAO_E_GENTE = new Set([
  'radiologia', 'radiologica', 'radiologico', 'radiografia', 'radiografias', 'telerradiografia',
  'raio', 'raios', 'rx', 'raiox', 'tomografia', 'tomografias', 'tomo', 'tomografo',
  'laboratorio', 'laboratorios', 'lab', 'imagem', 'imagens', 'exame', 'exames',
  'ultrassom', 'ultrassonografia', 'usg', 'ressonancia', 'mamografia', 'densitometria',
  'panoramica', 'panoramicas', 'cefalometria', 'escaneamento', 'scanner', 'documentacao',
  'diagnostico', 'diagnosticos', 'setor', 'sala', 'plantao', 'triagem', 'recepcao',
  'odonto', 'odontologia',
])

/**
 * O nome da agenda serve para "com {profissional}"? Cada dentista tem a sua
 * ("Dr. Igor"). Devolve o trecho pronto para depois de "com" — com o artigo
 * quando há título ("o Dr. Igor Talamoni", "a Dra. Leticia Ghilardi") — ou
 * null quando não dá para afirmar que é gente.
 *
 * 01/10, revisão: era uma lista do que NÃO é gente, e "Implantes", "Limpeza",
 * "Ortodontia" passavam ("Sua consulta com Implantes"). Na 2ª revisão, nem nome e
 * sobrenome sem título bastou ("Primeira Consulta", "Convênio Unimed"). Agora só
 * cita com título — Dr/Dra/Drª/Doutor/Doutora, com ou sem ponto — e com artigo.
 * Na dúvida fica sem: "Sua consulta está confirmada" é sempre verdade.
 *
 * 02/10: título não basta quando o que vem depois é setor ou exame ("DR.
 * RADIOLOGIA", "Dr. Raio-X") — ver SETOR_NAO_E_GENTE. Desde 02/10 o lembrete
 * da véspera também usa isto para dizer com quem é a consulta.
 */
export function profissionalDaAgenda(nome: string | null | undefined): string | null {
  let n = (nome ?? '').replace(/\s+/g, ' ').trim()
  if (!n || n.includes('@')) return null
  // "Agenda do Dr. Igor", "Agenda - Letícia", "Agenda Dr. Igor" → o que vem depois.
  n = n.replace(/^agenda(?:\s*[-–:|]\s*|\s+d[aoe]s?\s+|\s+)/i, '').trim()
  if (!n) return null

  // "Dr. Igor Talamoni", "Dra Leticia", "Drª Leticia", "Doutora Joyce" →
  // "o Dr. Igor Talamoni", "a Dra. Leticia". As formas femininas vêm antes:
  // com \b, "Drª" casava como "Dr" e virava "o Dr. ª Leticia". O lookahead
  // impede "Drenagem" de virar "Dr. enagem".
  const titulo = /^(?:(dr\.?\s*ª|dra|doutora)|(dr|doutor))(?!\p{L})\.?\s*(.*)$/iu.exec(n)
  if (titulo) {
    const resto = (titulo[3] ?? '').trim()
    // "Dr." sozinho, "Dr(a). Ana" (gênero em aberto): não dá para afirmar.
    if (!/^\p{L}/u.test(resto)) return null
    // "DR. RADIOLOGIA" (02/10): setor/exame com título não vira gente.
    if (semAcento(resto).split(/[^a-z0-9]+/).some((w) => SETOR_NAO_E_GENTE.has(w))) return null
    return titulo[1] ? `a Dra. ${resto}` : `o Dr. ${resto}`
  }
  // 01/10, 2ª revisão: sem título NÃO cita. "Primeira Consulta", "Convênio
  // Unimed", "Sorriso Perfeito" passavam como nome e sobrenome de gente. Na
  // dúvida fica sem: "Sua consulta está confirmada" é sempre verdade.
  return null
}

/**
 * Mesmo profissional escrito de dois jeitos ("Dr. Igor" e "Dr. Igor Talamoni")?
 * Recebe o que `profissionalDaAgenda` devolve. Exportada em 02/10: o lembrete
 * da véspera junta as cópias da consulta em várias agendas e só cita alguém
 * quando todas apontam para a mesma pessoa (meeting-reminder-profissional.ts).
 */
export function mesmoProfissional(a: string, b: string): boolean {
  const palavras = (s: string) =>
    semAcento(s)
      .replace(/^(o|a)\s+dra?\.\s*/, '')
      .split(/[^a-z]+/)
      .filter(Boolean)
  const [x, y] = [palavras(a), palavras(b)]
  const [curto, longo] = x.length <= y.length ? [x, y] : [y, x]
  return curto.length > 0 && curto.every((w, i) => longo[i] === w)
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
  'sou', 'serva', 'servo', 'nenem', 'nene', 'madrinha', 'padrinho', 'dinda', 'dindo', 'boneca',
  'abencoada', 'abencoado', 'dona', 'pastor', 'pastora', 'pr', 'bispo',
])

/** Títulos de perfil que vêm ANTES do nome ("Dona Maria", "Pastor João", "Pr. João"). */
const TITULO_DE_PERFIL = new Set(['dona', 'seu', 'pastor', 'pastora', 'pr', 'bispo', 'missionaria', 'missionario'])

function semTituloDePerfil(nome: string): string {
  const ws = nome.trim().split(/\s+/)
  while (ws.length > 1 && TITULO_DE_PERFIL.has(semAcento(ws[0] ?? '').replace(/[^a-z]/g, ''))) ws.shift()
  return ws.join(' ')
}

/**
 * O primeiro nome da saudação, ou '' para "Olá!". Regra dos disparos
 * (firstNameForGreeting) e, para nome que veio do PERFIL do WhatsApp
 * (`contacts.name_source = 'whatsapp'`), também a lista de apelidos acima.
 * Nome digitado no CRM ou da agenda do celular é decisão de gente: vale.
 */
export function nomeParaSaudacao(nome: string | null | undefined, nameSource?: string | null): string {
  // Só nome digitado por gente (CRM) ou da agenda do celular vale como está.
  // Os outros — perfil do WhatsApp e os contatos antigos (name_source null =
  // legado, também de perfil) — passam pelo filtro de títulos e apelidos.
  const digitado = nameSource === 'crm' || nameSource === 'phonebook'
  const primeiro = firstNameForGreeting(digitado ? nome : semTituloDePerfil(nome ?? ''))
  if (!primeiro || digitado) return primeiro
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

// ---------- A fila: espera e manda só a versão final (02/10) ----------

/**
 * Quanto a confirmação espera depois do ÚLTIMO salvar. Cada salvar com a caixa
 * marcada empurra a saída para agora + isto; o worker (tick de 30 s) manda o
 * estado que estiver gravado quando vencer. 3 min cobre o "salvei no horário
 * errado e corrigi" sem atrasar o paciente que ainda está no balcão.
 */
export const ATRASO_DA_CONFIRMACAO_MS = 3 * 60_000

/**
 * O que o paciente JÁ SABE da consulta (`calendar_events.confirmation_known`,
 * migração 0204): o estado da última confirmação que saiu, ou a base que a
 * recepção aceitou ao desmarcar a caixa. null = nada (consulta nova para ele).
 */
export type ConfirmacaoConhecida = { startsAt: string; calendarId: string; contactId: string | null }

export function isConfirmacaoConhecida(v: unknown): v is ConfirmacaoConhecida {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.startsAt === 'string' &&
    Number.isFinite(new Date(o.startsAt).getTime()) &&
    typeof o.calendarId === 'string' &&
    (o.contactId === null || typeof o.contactId === 'string')
  )
}

/**
 * O último desfecho da fila, para a tela (`confirmation_result`):
 * - enviada / incerta / naoEnviada: o que o envio devolveu;
 * - semMudanca: na hora de sair, nada que o paciente precisa saber tinha
 *   mudado (moveu e voltou) — não manda;
 * - descartada: a recepção desmarcou a caixa, ou o compromisso foi cancelado
 *   / ficou sem paciente antes de sair.
 */
export type StatusDaConfirmacao = 'enviada' | 'naoEnviada' | 'incerta' | 'semMudanca' | 'descartada'
export type DesfechoDaConfirmacao = { status: StatusDaConfirmacao; motivo?: string; at: string }

const STATUS_DA_CONFIRMACAO: readonly string[] = ['enviada', 'naoEnviada', 'incerta', 'semMudanca', 'descartada']

/**
 * Marcador que o worker grava em `confirmation_result` logo ANTES de enviar
 * (02/10, revisão). Se ele morrer entre o envio e o fechamento, o lease vence,
 * a linha volta para a fila e a confirmação sairia DUAS vezes. Achar este
 * marcador no começo do processamento = a tentativa anterior pode ter
 * enviado: fecha como incerta, sem reenviar.
 *
 * Não é desfecho: `isDesfechoDaConfirmacao` o recusa, então a tela nunca o
 * mostra como resultado (só como "saindo agora" — ver confirmacaoParaTela).
 */
export type ConfirmacaoEnviando = { status: 'enviando'; at: string }

export function isConfirmacaoEnviando(v: unknown): v is ConfirmacaoEnviando {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  // A hora tem que ser legível: a tela a usa como "saindo desde".
  return o.status === 'enviando' && typeof o.at === 'string' && Number.isFinite(Date.parse(o.at))
}

/** A coluna é jsonb livre: valida antes de entregar para a tela. */
export function isDesfechoDaConfirmacao(v: unknown): v is DesfechoDaConfirmacao {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.status === 'string' &&
    STATUS_DA_CONFIRMACAO.includes(o.status) &&
    typeof o.at === 'string' &&
    (o.motivo === undefined || typeof o.motivo === 'string')
  )
}

/**
 * Contra o que a próxima confirmação deste compromisso é comparada — a MESMA
 * regra no modal (que caixa mostrar) e na action (o que gravar como "já sabe"):
 *
 * - o que o paciente já sabe (`conhecido`), se houver;
 * - nada (null = consulta nova para ele) se há uma confirmação na fila sem
 *   base: é uma marcação que ainda não saiu;
 * - senão, o compromisso como está gravado (`atual`): compromisso antigo, de
 *   antes da fila, ou criado sem a caixa — o paciente soube dele de outro
 *   jeito (balcão, lembrete), como o modal sempre supôs. Compromisso novo:
 *   `atual` null.
 */
export function baseDaConfirmacao(args: {
  conhecido: ConfirmacaoConhecida | null
  pendente: boolean
  atual: ConfirmacaoConhecida | null
}): ConfirmacaoConhecida | null {
  if (args.conhecido) return args.conhecido
  if (args.pendente) return null
  return args.atual
}

export type DecisaoDaFila =
  | { acao: 'enviar'; tipo: TipoConfirmacao }
  | { acao: 'semMudanca' }
  | { acao: 'descartar'; motivo: string }

/**
 * Na hora de sair: o que mandar, comparando o estado FINAL com o que o
 * paciente já sabe. Cancelado ou sem paciente não manda e não vira aviso —
 * foi a própria recepção que mudou. Sem base: marcação. Nada mudou para o
 * paciente (moveu e voltou, trocou só o título): não manda.
 */
export function decidirNaFila(args: {
  final: { status: string; startsAt: string; calendarId: string; contactId: string | null; nomeAgenda?: string | null }
  conhecido: (ConfirmacaoConhecida & { nomeAgenda?: string | null }) | null
}): DecisaoDaFila {
  const { final, conhecido } = args
  if (final.status === 'cancelled') return { acao: 'descartar', motivo: 'o compromisso foi cancelado' }
  if (!final.contactId) return { acao: 'descartar', motivo: 'o compromisso ficou sem paciente' }
  if (!conhecido) return { acao: 'enviar', tipo: 'marcacao' }
  const tipo = tipoDaConfirmacaoNaEdicao({ antes: conhecido, depois: final })
  return tipo ? { acao: 'enviar', tipo } : { acao: 'semMudanca' }
}

/** O que o envio devolveu, no formato da coluna `confirmation_result`. */
export function desfechoDoEnvio(r: ResultadoConfirmacao, agora: Date): DesfechoDaConfirmacao {
  const at = agora.toISOString()
  if (r === 'enviada') return { status: 'enviada', at }
  if ('incerta' in r) return { status: 'incerta', motivo: r.incerta, at }
  return { status: 'naoEnviada', motivo: r.naoEnviada, at }
}

/**
 * A nota interna na conversa do paciente quando a confirmação da fila NÃO saiu
 * (ou não se sabe). Antes o motivo ia num toast que sumia; agora a recepção já
 * saiu do modal quando o worker tenta, então o aviso tem que ficar onde ela
 * olha: na conversa (e no compromisso, pela coluna). null = nada a anotar.
 */
export function notaDaConfirmacaoQueNaoSaiu(args: {
  desfecho: DesfechoDaConfirmacao
  startsAt: string
  allDay: boolean
  tz: string
}): string | null {
  const { desfecho } = args
  const quando = quandoDaConsulta(args)
  if (desfecho.status === 'incerta') {
    return `⚠️ Confirmação da consulta de ${quando}: não deu para confirmar se a mensagem saiu; confira a conversa antes de reenviar.`
  }
  if (desfecho.status === 'naoEnviada') {
    return `⚠️ Confirmação da consulta de ${quando} não enviada: ${desfecho.motivo || 'o envio falhou'}.`
  }
  return null
}

/**
 * "14:06" no fuso da conta — quando a confirmação da fila sai. Arredonda para
 * CIMA no minuto: o worker passa a cada 30 s, então "sai às 14:05" para um
 * vencimento às 14:05:40 prometeria um minuto que já passou.
 */
export function horaDaFila(iso: string, tz: string): string {
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) return ''
  const p = partes(new Date(Math.ceil(ms / 60_000) * 60_000), tz)
  return `${p.hour}:${p.minute}`
}

/** "01/10 às 14:05" no fuso da conta ("Confirmação enviada em …"). */
export function diaEHoraNoFuso(iso: string, tz: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const p = partes(d, tz)
  return `${p.day}/${p.month} às ${p.hour}:${p.minute}`
}
