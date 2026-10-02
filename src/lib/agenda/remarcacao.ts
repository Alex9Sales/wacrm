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
// Aqui: a sugestão de resposta (pelo nome da pessoa no título), o texto de
// cada opção e a regra de "ainda vai acontecer". Sem banco e sem
// 'server-only': o modal e a action usam as mesmas funções.
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

function palavrasDasAgendas(nomesDeAgendas: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const nome of nomesDeAgendas) {
    for (const t of nome.match(TOKEN) ?? []) {
      const w = palavra(t)
      if (w.length >= 3) out.add(w)
    }
  }
  return out
}

/**
 * As pessoas que um título nomeia, cada uma como a lista das palavras do nome
 * (a primeira é o primeiro nome). Fica de fora: palavra genérica ("avaliação",
 * "retorno"), o profissional ("Dra. Helena"), palavra de nome de agenda e
 * palavra com menos de 3 letras.
 *
 * "Avaliação Dra. Helena · Davi Moura" → [["davi", "moura"]]
 * "Rosana (Davi e Bianca)"              → [["rosana"], ["davi"], ["bianca"]]
 */
export function pessoasDoTitulo(titulo: string, nomesDeAgendas: readonly string[] = []): string[][] {
  const ignorar = palavrasDasAgendas(nomesDeAgendas)
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
 * Mesma pessoa? O primeiro nome de um aparece no nome do outro. Só o
 * sobrenome NÃO basta: irmãos têm o mesmo ("Bianca Moura" ≠ "Davi Moura").
 */
function mesmaPessoa(a: string[], b: string[]): boolean {
  const [pa, pb] = [a[0], b[0]]
  return (pa !== undefined && b.includes(pa)) || (pb !== undefined && a.includes(pb))
}

/**
 * A resposta sugerida para "Esta é:" — o id da consulta a remarcar, ou null
 * para "consulta nova".
 *
 * Remarcação só quando o título novo nomeia UMA pessoa e ela é a pessoa de
 * UMA consulta existente. Qualquer dúvida é "nova", como era antes da
 * pergunta existir: remarcar a consulta errada some com o horário de outro
 * paciente da família (pior do que deixar uma sobrando, que a recepção vê).
 * - título novo sem nome ("Avaliação") ou com mais de uma pessoa (o nome do
 *   contato da família, "Rosana (Davi e Bianca)") → nova;
 * - consulta existente cujo título nomeia mais de uma pessoa não serve de pista;
 * - casou com mais de uma consulta → nova.
 */
export function sugerirRemarcacao(
  tituloNovo: string,
  consultas: readonly { id: string; title: string }[],
  nomesDeAgendas: readonly string[] = [],
): string | null {
  const novo = pessoasDoTitulo(tituloNovo, nomesDeAgendas)
  if (novo.length !== 1) return null
  const quem = novo[0]
  const casam = consultas.filter((c) => {
    const p = pessoasDoTitulo(c.title, nomesDeAgendas)
    return p.length === 1 && mesmaPessoa(quem, p[0])
  })
  return casam.length === 1 ? casam[0].id : null
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
