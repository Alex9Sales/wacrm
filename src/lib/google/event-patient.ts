// ============================================================
// 🩺 O paciente do compromisso VAI JUNTO para o Google.
//
// 01/10 (dona de uma clínica): "como eu faço para quando eu agendar o paciente as
// informações do paciente ficarem vinculadas na agenda do Google também?". Ela
// criou "RSC" no CRM com a paciente escolhida e no Google apareceu só "rsc" —
// o CRM mandava título, descrição e local, e o paciente ficava para trás.
//
// Agora o evento leva:
//  - no título, o nome do paciente ("RSC · Ana Teste"), que é o que aparece na
//    grade do Google sem precisar abrir o evento;
//  - no FIM da descrição, um bloco do FluxiaCRM com "Paciente:" e "Telefone:",
//    no mesmo formato que o Capim já escreve — é o que o import
//    (event-contact.ts → phoneFromDescription) lê para religar o contato.
//
// ⚠️ IDA E VOLTA. O sync de 5 em 5 min SOBRESCREVE título e descrição do CRM
// com o que vem do Google, então o bloco e o sufixo do título voltam para cá
// sozinhos. Tudo aqui tem que ser idempotente: aplicar de novo sobre o que
// voltou não pode duplicar nada. Por isso o bloco tem uma linha marcadora
// própria — é ela que permite trocar o bloco velho pelo atual sem encostar no
// resto da descrição (as linhas do Capim, o que a recepção digitou).
//
// Sem 'server-only': o worker do sync alcança este arquivo.
// ============================================================

import { isBarePhone } from '@/lib/contacts/name-rule'

/** Nome e telefone crus do contato ligado ao compromisso (como estão no banco). */
export type PacienteDoEvento = { name: string | null; phone: string | null }

/** Linha que abre o bloco do FluxiaCRM na descrição do Google. */
export const MARCADOR_FLUXIA = '— FluxiaCRM —'

const QUEBRA = String.raw`(?:\r?\n|<br\s*/?>)`
const MARCADOR_RE = MARCADOR_FLUXIA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// O bloco: a marcadora numa linha só, seguida das NOSSAS duas linhas (cada uma
// opcional, nesta ordem). Engole também as quebras antes da marcadora, que são
// o espaçamento que nós mesmos pusemos. `<br>` conta como quebra porque o Google
// devolve HTML quando alguém edita a descrição pela tela dele.
const FONTE_BLOCO =
  String.raw`(?:^|(?:[ \t]*${QUEBRA})+)[ \t]*${MARCADOR_RE}[ \t]*(?=${QUEBRA}|$)` +
  String.raw`(?:${QUEBRA}[ \t]*Paciente[ \t]*:[ \t]*([^\r\n<]*))?` +
  String.raw`(?:${QUEBRA}[ \t]*Telefone[ \t]*:[ \t]*([^\r\n<]*))?`

/** Sem acento, minúsculo — "Ana" casa com "ANA" e "Conceição" com "conceicao". */
function normalizar(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

function palavras(s: string): string[] {
  return normalizar(s).split(/[^a-z0-9]+/).filter(Boolean)
}

/** Nome de verdade do contato, numa linha só — ou null (vazio, ou é o próprio telefone). */
function nomeDoPaciente(name: string | null | undefined): string | null {
  const n = (name ?? '').replace(/\s+/g, ' ').trim()
  if (!n || isBarePhone(n)) return null
  return n
}

/**
 * Telefone no formato que a recepção lê: "(11) 98765-4321".
 *
 * Com ou sem o 55 (o ERP grava sem). Número de fora do Brasil vai com "+" e os
 * dígitos. Menos de 10 dígitos não identifica ninguém (falta o DDD) e não vai.
 */
export function telefoneLegivel(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '')
  if (d.length < 10) return null
  const nacional = d.startsWith('55') && (d.length === 12 || d.length === 13) ? d.slice(2) : d
  if (nacional.length === 10 || nacional.length === 11) {
    const resto = nacional.slice(2)
    return `(${nacional.slice(0, 2)}) ${resto.slice(0, -4)}-${resto.slice(-4)}`
  }
  return `+${d}`
}

/**
 * O texto já traz este telefone? Compara pelos 8 últimos dígitos (a mesma chave
 * do import, `phoneKey`), em qualquer trecho com cara de telefone — o Capim
 * escreve "(54) 9917-1108" e o CRM guarda "5554999171108".
 */
export function textoTemTelefone(texto: string | null | undefined, phone: string | null | undefined): boolean {
  const alvo = (phone ?? '').replace(/\D/g, '')
  if (alvo.length < 8) return false
  const chave = alvo.slice(-8)
  for (const trecho of (texto ?? '').match(/\+?\(?\d[\d \t().-]*\d/g) ?? []) {
    const d = trecho.replace(/\D/g, '')
    // ≥ 10: com DDD. Abaixo disso é cadeira, id do Capim, data — não telefone.
    if (d.length >= 10 && d.slice(-8) === chave) return true
  }
  return false
}

/** A descrição sem o bloco do FluxiaCRM. Nenhuma outra linha sai. */
export function tirarBlocoFluxia(description: string | null | undefined): string {
  const texto = description ?? ''
  if (!/fluxiacrm/i.test(texto)) return texto.trim()
  return texto.replace(new RegExp(FONTE_BLOCO, 'gi'), '').trim()
}

/**
 * Quem o bloco do FluxiaCRM dizia que era o paciente (o nome, ou o telefone
 * quando não havia nome). É o que permite tirar do título o sufixo de um
 * paciente que foi trocado ou desligado do compromisso.
 */
export function rotuloDoBlocoFluxia(description: string | null | undefined): string | null {
  const m = new RegExp(FONTE_BLOCO, 'i').exec(description ?? '')
  if (!m) return null
  return m[1]?.trim() || m[2]?.trim() || null
}

/**
 * Descrição que vai para o Google: a do CRM, sem o bloco antigo, com o bloco
 * do paciente atual no fim.
 *
 * Não põe bloco quando a descrição já traz o telefone do paciente — o evento do
 * Capim já vem com "Paciente:" e "Telefone:", repetir só polui. Devolve null
 * quando não havia descrição e não há o que acrescentar (o Google fica como está).
 */
export function descricaoParaGoogle(
  description: string | null | undefined,
  paciente: PacienteDoEvento | null,
): string | null {
  const base = tirarBlocoFluxia(description)
  const nome = nomeDoPaciente(paciente?.name)
  const telefone = telefoneLegivel(paciente?.phone)
  const linhas = [nome && `Paciente: ${nome}`, telefone && `Telefone: ${telefone}`].filter(Boolean)
  const jaTem = telefone !== null && textoTemTelefone(base, paciente?.phone)
  if (!linhas.length || jaTem) return description == null ? null : base
  const bloco = [MARCADOR_FLUXIA, ...linhas].join('\n')
  return base ? `${base}\n\n${bloco}` : bloco
}

// "Dra. Ana" não pode fazer qualquer título com "Dra" parecer já ter o paciente.
const PRONOMES = new Set(['sr', 'sra', 'srta', 'dr', 'dra'])

/** O título já identifica este paciente? Ver o teste "basta o primeiro nome". */
function tituloJaTem(titulo: string, nome: string | null, phone: string | null | undefined): boolean {
  if (nome) {
    const primeiro = palavras(nome).find((p) => !PRONOMES.has(p))
    return primeiro !== undefined && palavras(titulo).includes(primeiro)
  }
  return textoTemTelefone(titulo, phone)
}

/** Tira " · <rótulo>" do fim do título (ou o título inteiro, se era só o rótulo). */
function semSufixo(titulo: string, rotulo: string): string {
  if (normalizar(titulo) === normalizar(rotulo)) return ''
  const sufixo = ` · ${rotulo}`
  if (titulo.length > sufixo.length && normalizar(titulo.slice(-sufixo.length)) === normalizar(sufixo)) {
    return titulo.slice(0, -sufixo.length).trim()
  }
  return titulo
}

/**
 * Título que vai para o Google: "<título> · <Nome do paciente>", a não ser que
 * o título já traga o paciente. Sem nome, vai o telefone. Título vazio → só o
 * paciente.
 *
 * `rotuloAnterior` é o paciente que o bloco antigo da descrição registrava: se
 * mudou (ou saiu), o sufixo dele sai do título antes de entrar o novo.
 */
export function tituloParaGoogle(
  title: string | null | undefined,
  paciente: PacienteDoEvento | null,
  rotuloAnterior?: string | null,
): string {
  const original = (title ?? '').trim()
  const nome = nomeDoPaciente(paciente?.name)
  const rotulo = nome ?? telefoneLegivel(paciente?.phone)
  // O import grava "(sem título)" quando o Google não tem título.
  let base = original === '(sem título)' ? '' : original
  if (rotuloAnterior && (!rotulo || normalizar(rotuloAnterior) !== normalizar(rotulo))) {
    base = semSufixo(base, rotuloAnterior)
  }
  if (!rotulo) return base || original
  if (!base) return rotulo
  if (tituloJaTem(base, nome, paciente?.phone)) return base
  return `${base} · ${rotulo}`
}

/** Título e descrição do compromisso do CRM do jeito que vão para o Google. */
export function eventoParaGoogle(
  ev: { title: string; description: string | null },
  paciente: PacienteDoEvento | null,
): { summary: string; description: string | null } {
  return {
    summary: tituloParaGoogle(ev.title, paciente, rotuloDoBlocoFluxia(ev.description)),
    description: descricaoParaGoogle(ev.description, paciente),
  }
}
