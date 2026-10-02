// ============================================================
// 🔁 Remarcação ou consulta nova? — a parte pura (02/10/2026).
//
// 01/10, numa clínica: a IA marcou a avaliação de um menino para o dia 14. À
// noite a recepção falou com a mãe e marcou ele para o dia 15 e a irmã (MESMO
// contato, mesmo telefone) logo depois, com outra profissional — criando
// consultas NOVAS no modal. A do dia 14 ficou ativa: lembrete do horário
// errado e uma cadeira ocupada à toa.
//
// Cancelar sozinho é perigoso: ~20 pacientes da clínica têm 2-3 consultas
// futuras no mesmo contato (famílias). O dono aprovou: quando a recepção marca
// para quem JÁ TEM consulta futura, o modal PERGUNTA se é remarcação (de qual)
// ou consulta nova. Remarcar EDITA a consulta antiga (histórico, Google,
// lembretes e a confirmação "remarcada" vão pelo caminho da edição) — ver
// createEvent em app/(dashboard)/agenda/actions.ts.
//
// Aqui: o destaque "parece ser a mesma pessoa" (pelo nome no título), o texto
// de cada opção, a regra de "ainda vai acontecer" e o que a remarcação grava
// em X. Sem banco e sem 'server-only': o modal e a action usam as mesmas
// funções.
//
// 02/10, revisão: a sugestão pelo nome vinha PRÉ-MARCADA e errava (o nome da
// mãe que o modal põe no título vazio, nome composto, sobrenome de irmãos,
// "Retorno Davi" × "Avaliação Davi"). Agora nada vem marcado: a recepção
// RESPONDE, e a sugestão vira só um destaque visual.
// ============================================================

import { quandoDaConsulta } from './confirmacao-agendamento'

const semAcento = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

/**
 * Palavras que aparecem em título de consulta e não são nome de gente. Na
 * dúvida a sugestão fica em "consulta nova" (o que já acontecia antes): por
 * isso a lista pode errar para MAIS, nunca para menos.
 */
const GENERICAS = new Set([
  // o tipo da consulta
  'avaliacao', 'consulta', 'consultas', 'retorno', 'limpeza', 'revisao', 'manutencao', 'orcamento',
  'primeira', 'vez', 'encaixe', 'urgencia', 'emergencia', 'sessao', 'procedimento', 'atendimento',
  'reuniao', 'exame', 'exames', 'raio', 'radiografia', 'tomografia', 'cirurgia', 'extracao',
  'implante', 'implantes', 'canal', 'restauracao', 'clareamento', 'aparelho', 'ortodontia',
  'profilaxia', 'protese', 'botox', 'harmonizacao', 'facial', 'estetica', 'moldagem', 'instalacao',
  'remocao', 'controle', 'acompanhamento', 'tratamento', 'continuacao', 'inicio', 'fim',
  'remarcada', 'remarcado', 'remarcacao', 'confirmada', 'confirmado', 'nova', 'novo',
  'paciente', 'agenda', 'horario', 'online', 'presencial', 'particular', 'convenio', 'plano',
  'infantil', 'adulto', 'crianca', 'odonto', 'odontologia', 'dentista', 'dente', 'dentes',
  // parentesco ("Davi (filho)") não é o nome de ninguém
  'mae', 'pai', 'filho', 'filha', 'irmao', 'irma', 'responsavel', 'esposa', 'esposo', 'marido',
  // preposições e artigos de 3+ letras (os menores já caem pelo tamanho)
  'com', 'para', 'pra', 'pro', 'das', 'dos', 'nas', 'nos', 'aos', 'uma', 'sem', 'por', 'pelo', 'pela',
])

/**
 * O TIPO da consulta, das palavras genéricas (02/10, revisão). "Retorno Davi"
 * e "Avaliação Davi" são consultas DIFERENTES do mesmo menino — o retorno não
 * remarca a avaliação. Sinônimos e plurais viram a mesma chave.
 * "Consulta"/"atendimento" não dizem o tipo: ficam de fora.
 */
const TIPOS: ReadonlyMap<string, string> = new Map([
  ['avaliacao', 'avaliacao'], ['retorno', 'retorno'], ['limpeza', 'limpeza'], ['profilaxia', 'limpeza'],
  ['revisao', 'revisao'], ['manutencao', 'manutencao'], ['orcamento', 'orcamento'], ['encaixe', 'encaixe'],
  ['urgencia', 'urgencia'], ['emergencia', 'urgencia'], ['sessao', 'sessao'], ['procedimento', 'procedimento'],
  ['exame', 'exame'], ['exames', 'exame'], ['raio', 'raio'], ['radiografia', 'raio'], ['tomografia', 'tomografia'],
  ['cirurgia', 'cirurgia'], ['extracao', 'extracao'], ['implante', 'implante'], ['implantes', 'implante'],
  ['canal', 'canal'], ['restauracao', 'restauracao'], ['clareamento', 'clareamento'], ['aparelho', 'aparelho'],
  ['ortodontia', 'ortodontia'], ['protese', 'protese'], ['botox', 'botox'], ['harmonizacao', 'harmonizacao'],
  ['moldagem', 'moldagem'], ['instalacao', 'instalacao'], ['remocao', 'remocao'], ['controle', 'controle'],
  ['acompanhamento', 'acompanhamento'], ['tratamento', 'tratamento'], ['continuacao', 'continuacao'],
  ['reuniao', 'reuniao'],
])

/** "Dr./Dra./Drª/Doutor(a)": o que vem depois é o PROFISSIONAL, até a próxima pontuação. */
const TITULO_DE_PROFISSIONAL = new Set(['dr', 'dra', 'drs', 'dras', 'doutor', 'doutora'])

/**
 * Pontuação que separa PESSOAS: "Davi e Bianca", "Rosana (Davi e Bianca)",
 * "Davi, Bianca", "Davi / Bianca". O "e" sozinho também (tratado como palavra).
 * Já "·", "-", ":", "|" só encerram o nome do profissional ("Avaliação Dra.
 * Helena · Davi Moura" é UMA pessoa: o paciente).
 */
const SEPARA_PESSOAS = new Set([',', ';', '/', '&', '+', '(', ')', '[', ']'])

/** Palavras (≥ 3 letras) ou um caractere de pontuação que importa. O ponto de "Dra." fica de fora. */
const TOKEN = /\p{L}+|[,;/&+()[\]·•|:\-–—]/gu

function palavra(token: string): string {
  // "Drª" → "dr": a ª não se decompõe no NFD; sobra só o que é a-z.
  return semAcento(token).replace(/[^a-z]/g, '')
}

/** As palavras (≥ 3 letras) de uma lista de nomes — de agenda ou do contato. */
function palavrasDosNomes(nomes: readonly (string | null | undefined)[]): Set<string> {
  const out = new Set<string>()
  for (const nome of nomes) {
    for (const t of (nome ?? '').normalize('NFC').match(TOKEN) ?? []) {
      const w = palavra(t)
      if (w.length >= 3) out.add(w)
    }
  }
  return out
}

/** Os tipos de consulta que um título diz ("Avaliação e limpeza · Davi" → avaliacao, limpeza). */
export function tiposDoTitulo(titulo: string): Set<string> {
  const out = new Set<string>()
  for (const t of titulo.normalize('NFC').match(TOKEN) ?? []) {
    const tipo = TIPOS.get(palavra(t))
    if (tipo) out.add(tipo)
  }
  return out
}

/**
 * Tipos diferentes? Só quando os DOIS títulos dizem o tipo e não dizem o
 * mesmo. Título sem tipo ("Davi") não contradiz nada.
 */
function tiposDiferentes(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false
  if (a.size !== b.size) return true
  for (const t of a) if (!b.has(t)) return true
  return false
}

/**
 * As pessoas que um título nomeia, cada uma como a lista das palavras do nome
 * (a primeira é o primeiro nome). Fica de fora: palavra genérica ("avaliação",
 * "retorno"), o profissional ("Dra. Helena"), palavra de nome de agenda,
 * palavra do NOME DO CONTATO e palavra com menos de 3 letras.
 *
 * O nome do contato sai dos dois lados (02/10, revisão): numa família o
 * contato é a mãe, o modal põe o nome dela no título vazio e o sobrenome dela
 * é o dos filhos — "Rosana Moura" casava com "Davi Moura".
 *
 * "Avaliação Dra. Helena · Davi Moura" → [["davi", "moura"]]
 * "Rosana (Davi e Bianca)"              → [["rosana"], ["davi"], ["bianca"]]
 */
export function pessoasDoTitulo(
  titulo: string,
  nomesDeAgendas: readonly string[] = [],
  nomeDoContato: string | null = null,
): string[][] {
  const ignorar = palavrasDosNomes([...nomesDeAgendas, nomeDoContato])
  const pessoas: string[][] = []
  let atual: string[] = []
  let profissional = false
  const fecha = () => {
    if (atual.length > 0) pessoas.push(atual)
    atual = []
  }
  for (const token of titulo.normalize('NFC').match(TOKEN) ?? []) {
    if (!/\p{L}/u.test(token)) {
      profissional = false
      if (SEPARA_PESSOAS.has(token)) fecha()
      continue
    }
    const w = palavra(token)
    // O "e" de verdade, não o "é" ("Davi é retorno" é uma pessoa só).
    if (token.toLowerCase() === 'e') {
      profissional = false
      fecha()
      continue
    }
    if (TITULO_DE_PROFISSIONAL.has(w)) {
      profissional = true
      continue
    }
    if (profissional) continue
    if (w.length < 3 || GENERICAS.has(w) || ignorar.has(w)) continue
    atual.push(w)
  }
  fecha()
  return pessoas
}

/**
 * Mesma pessoa? O nome COMPLETO de um está no nome do outro ("Davi" ⊂ "Davi
 * Moura"). Até 02/10 bastava o primeiro nome: "Maria Clara" casava com "Maria
 * Eduarda". Só o sobrenome também não basta: irmãos têm o mesmo.
 */
function mesmaPessoa(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  const contido = (x: string[], y: string[]) => x.every((w) => y.includes(w))
  return contido(a, b) || contido(b, a)
}

/**
 * A consulta que PARECE ser da mesma pessoa do compromisso novo — só um
 * destaque visual no modal (02/10, revisão). Não marca resposta nenhuma: a
 * recepção TEM que responder "remarcação de qual" ou "consulta nova". null =
 * sem destaque.
 *
 * Destaca só quando é bem provável — errar aqui empurra a recepção para
 * remarcar a consulta de OUTRA pessoa da família:
 * - o título novo nomeia UMA pessoa (depois de tirar o nome do contato, das
 *   agendas e as palavras genéricas);
 * - o nome completo de um está no nome do outro ("Davi" × "Davi Moura"), e
 *   não só o primeiro nome ("Maria Clara" × "Maria Eduarda");
 * - o tipo não é diferente ("Retorno Davi" não destaca "Avaliação Davi");
 * - casou com UMA consulta só (consulta que nomeia mais de uma pessoa não
 *   serve de pista).
 */
export function sugerirRemarcacao(
  tituloNovo: string,
  consultas: readonly { id: string; title: string }[],
  nomesDeAgendas: readonly string[] = [],
  nomeDoContato: string | null = null,
): string | null {
  const novo = pessoasDoTitulo(tituloNovo, nomesDeAgendas, nomeDoContato)
  if (novo.length !== 1) return null
  const quem = novo[0]
  const tiposNovo = tiposDoTitulo(tituloNovo)
  const casam = consultas.filter((c) => {
    const p = pessoasDoTitulo(c.title, nomesDeAgendas, nomeDoContato)
    return p.length === 1 && mesmaPessoa(quem, p[0]) && !tiposDiferentes(tiposNovo, tiposDoTitulo(c.title))
  })
  return casam.length === 1 ? casam[0].id : null
}

/** O que o modal manda na remarcação (o formulário + o que só ela precisa). */
export type FormularioDaRemarcacao = {
  title: string
  startsAt: string
  endsAt: string
  allDay?: boolean
  calendarId?: string | null
  description?: string | null
  location?: string | null
  contactId?: string | null
  notifyPatient?: boolean
  descartarConfirmacaoPendente?: boolean
  conversationId?: string | null
  /**
   * A recepção DIGITOU o título (02/10, revisão). O modal põe o nome do
   * contato no título vazio — isso não conta: é o nome da mãe, não de quem é
   * a consulta.
   */
  tituloDigitado?: boolean
}

/** O que vai para a edição de X (updateEvent). Título só se digitado. */
export type CamposDaRemarcacao = Omit<FormularioDaRemarcacao, 'title' | 'tituloDigitado'> & { title?: string }

/**
 * O que a remarcação grava em X (02/10, revisão). Antes ia o formulário
 * inteiro: o título de X (onde está o nome de QUAL filho) virava o nome do
 * contato que o modal pôs no título vazio, e a descrição e o local de X eram
 * apagados pelos campos em branco do compromisso novo.
 *
 * Vai: dia/hora, dia inteiro, agenda, paciente e o que a confirmação precisa.
 * O título só se a recepção o digitou; descrição e local só se preenchidos.
 */
export function camposDaRemarcacao(f: FormularioDaRemarcacao): CamposDaRemarcacao {
  const titulo = f.title?.trim()
  const descricao = f.description?.trim()
  const local = f.location?.trim()
  return {
    startsAt: f.startsAt,
    endsAt: f.endsAt,
    ...(f.allDay !== undefined ? { allDay: f.allDay } : {}),
    calendarId: f.calendarId ?? null,
    contactId: f.contactId ?? null,
    ...(f.notifyPatient !== undefined ? { notifyPatient: f.notifyPatient } : {}),
    ...(f.descartarConfirmacaoPendente !== undefined
      ? { descartarConfirmacaoPendente: f.descartarConfirmacaoPendente }
      : {}),
    conversationId: f.conversationId ?? null,
    ...(f.tituloDigitado === true && titulo ? { title: titulo } : {}),
    ...(descricao ? { description: descricao } : {}),
    ...(local ? { location: local } : {}),
  }
}

/**
 * A consulta ainda vai acontecer? Com hora, até começar; dia inteiro, até o
 * fim do dia — a mesma régua da confirmação (decidirConfirmacao).
 */
export function aindaVaiAcontecer(c: { startsAt: string; endsAt: string; allDay: boolean }, agora: Date): boolean {
  const limite = new Date(c.allDay ? c.endsAt : c.startsAt).getTime()
  return Number.isFinite(limite) && limite > agora.getTime()
}

/**
 * O servidor confere a consulta escolhida para remarcar ANTES de gravar: é do
 * MESMO paciente do formulário, está de pé ('confirmed') e ainda vai
 * acontecer. Entre abrir o modal e salvar, a consulta pode ter sido cancelada
 * (no Google, por outra pessoa) ou o paciente trocado. `alvo` null = não é
 * desta conta (a action já procura com a conta).
 */
export function podeRemarcar(
  alvo: { status: string; contactId: string | null; startsAt: string; endsAt: string; allDay: boolean } | null,
  contactId: string | null | undefined,
  agora: Date,
): boolean {
  if (!alvo || !contactId) return false
  if (alvo.contactId !== contactId) return false
  if (alvo.status !== 'confirmed') return false
  return aindaVaiAcontecer(alvo, agora)
}

/** Aviso quando a consulta escolhida não passa em `podeRemarcar`. */
export const ERRO_REMARCACAO_INDISPONIVEL =
  'A consulta que você escolheu remarcar não está mais disponível (foi cancelada, já passou ou é de outro paciente). Nada foi salvo — confira e escolha de novo.'

/**
 * O texto da opção no modal, no fuso da conta:
 * "Remarcação da consulta de terça-feira, 13/10/2026, às 9h30 com Dra. Helena
 * (Avaliação · Davi) — a antiga deixa de valer".
 */
export function rotuloDaRemarcacao(
  c: { startsAt: string; allDay: boolean; calendarName: string | null; title: string },
  tz: string,
): string {
  const quando = quandoDaConsulta({ startsAt: c.startsAt, allDay: c.allDay, tz })
  const com = c.calendarName?.trim() ? ` com ${c.calendarName.trim()}` : ''
  const titulo = c.title.trim() ? ` (${c.title.trim()})` : ''
  return `Remarcação da consulta de ${quando}${com}${titulo} — a antiga deixa de valer`
}

/**
 * Remarcação com OUTRA agenda (02/10, revisão): a consulta X é com um
 * profissional e o formulário está com outro. Pode ser de propósito (troca de
 * profissional), mas a recepção precisa ver antes de salvar. null = mesma
 * agenda (ou nenhuma escolhida).
 */
export function avisoDeTrocaDeProfissional(
  x: { startsAt: string; allDay: boolean; calendarId: string; calendarName: string | null },
  agendaDoFormulario: { id: string; name: string | null } | null,
  tz: string,
): string | null {
  if (!agendaDoFormulario || agendaDoFormulario.id === x.calendarId) return null
  const quando = quandoDaConsulta({ startsAt: x.startsAt, allDay: x.allDay, tz })
  const deX = x.calendarName?.trim() || 'outra agenda'
  const outra = agendaDoFormulario.name?.trim() || 'outra agenda'
  return `A consulta de ${quando} é com ${deX}; você está salvando com ${outra} (troca de profissional).`
}
