// ============================================================
// 🚧 Por que o lembrete daquela consulta NÃO saiu.
//
// 30/09/2026. O Alex marcou uma reunião pelo CRM para testar o campo novo de
// paciente. O lembrete não saiu — e o sistema marcou como enviado assim mesmo.
// Ele perguntou se era falta de template; não era (o canal é WAHA, que não usa
// template). Era a IA pausada naquela conversa. Mas o que importa não é a causa
// daquele caso: é que o CRM **deu o lembrete por feito sem ter mandado nada**.
//
// `reminders_sent` é um contador que só anda para frente. Queimar um degrau que
// não saiu é perder aquele aviso PARA SEMPRE — e quem marcou a consulta não
// fica sabendo. É o mesmo silêncio do lembrete do João, que passou seis dias
// desligado porque uma metade da configuração estava em branco. Aqui o silêncio
// custa paciente que não é avisado da consulta.
//
// A regra passa a ser uma só: **só queima o degrau o que não tem volta.**
//
//   DEFINITIVO (queima)  — a hora daquele lembrete passou e mandar agora seria
//                          pior: o card saiu da etapa, ou a própria IA leu a
//                          conversa e concluiu que não cabia mensagem.
//   TEMPORÁRIO (segura)  — a condição pode mudar sozinha até a consulta: a IA
//                          está pausada, falta template, o envio falhou, o
//                          contato ainda não tem conversa.
//
// Segurar é barato e não acumula: o sweep sempre tenta só o degrau vencido MAIS
// RECENTE (`dueIdx`), então um degrau preso é naturalmente descartado quando o
// próximo vence — e nenhum lembrete atrasado cai em cima do paciente de uma vez.
//
// Sem 'server-only' de propósito: a tela da Agenda importa os rótulos daqui
// para dizer, no próprio compromisso, que aquele paciente não será avisado.
// ============================================================

/** Motivos pelos quais um lembrete de reunião ficou travado. */
export type MeetingReminderBlock =
  /** O contato não tem nenhuma conversa — não há por onde falar com ele. */
  | 'sem_conversa'
  /** A IA foi pausada naquela conversa (decisão explícita de alguém). */
  | 'ia_pausada'
  /** Canal oficial fora da janela de 24h e nenhum template configurado. */
  | 'sem_template'
  /** O template existe, mas a Meta recusou o envio. */
  | 'template_falhou'
  /** A conversa não tem histórico — a IA não teria o que contextualizar. */
  | 'sem_historico'
  /** A mensagem foi gerada, mas o canal recusou na hora de enviar. */
  | 'envio_falhou'
  /** A IA não conseguiu escrever o texto (chave sem saldo, provedor fora). */
  | 'ia_falhou'
  /** O agente está sem configuração de IA utilizável — não há quem escreva. */
  | 'sem_ia'
  /** É consulta de uma pessoa de verdade, mas ninguém está ligado a ela. */
  | 'sem_paciente'

const MOTIVOS: MeetingReminderBlock[] = [
  'sem_conversa',
  'ia_pausada',
  'sem_template',
  'template_falhou',
  'sem_historico',
  'envio_falhou',
  'ia_falhou',
  'sem_ia',
  'sem_paciente',
]

/** Valida o que veio do banco — coluna de texto aceita qualquer coisa. */
export function isMeetingReminderBlock(v: unknown): v is MeetingReminderBlock {
  return typeof v === 'string' && (MOTIVOS as string[]).includes(v)
}

/**
 * O que o dono da agenda lê no compromisso.
 *
 * Fala do PACIENTE, não do sistema: quem abre a agenda quer saber se a pessoa
 * vai ser avisada, não qual função retornou null.
 */
export function rotuloDoBloqueio(motivo: MeetingReminderBlock): {
  curto: string
  explicacao: string
  comoResolver: string
} {
  switch (motivo) {
    case 'sem_conversa':
      return {
        curto: 'sem WhatsApp',
        explicacao:
          'Este contato não tem nenhuma conversa aberta, então não há por onde mandar o lembrete.',
        comoResolver: 'Mande uma mensagem para ele uma vez — a partir daí o lembrete sai sozinho.',
      }
    case 'ia_pausada':
      return {
        curto: 'IA pausada nesta conversa',
        explicacao:
          'A assistente foi desligada na conversa deste contato, e lembrete não sai onde alguém desligou a IA de propósito.',
        comoResolver: 'Reative a IA na conversa, se quiser que ele receba o lembrete.',
      }
    case 'sem_template':
      return {
        curto: 'falta template aprovado',
        explicacao:
          'O canal é oficial (Meta) e já passou 24h da última mensagem do cliente. Fora dessa janela a Meta só aceita template aprovado, e nenhum foi escolhido para este lembrete.',
        comoResolver:
          'Em Agentes → Follow-up, escolha um template aprovado para este degrau do lembrete.',
      }
    case 'template_falhou':
      return {
        curto: 'a Meta recusou o template',
        explicacao:
          'O template está configurado, mas a Meta recusou o envio — em geral é template de OUTRO número, ou o número de variáveis não bate.',
        comoResolver: 'Confira se o template é do mesmo canal que envia e se as variáveis batem.',
      }
    case 'sem_historico':
      return {
        curto: 'conversa sem histórico',
        explicacao:
          'A conversa deste contato está vazia, e a assistente escreve o lembrete a partir do histórico.',
        comoResolver: 'Troque uma mensagem com ele — depois disso o lembrete sai.',
      }
    case 'envio_falhou':
      return {
        curto: 'o canal recusou o envio',
        explicacao:
          'A mensagem foi escrita, mas o canal recusou na hora de enviar — em geral o número está fora do ar.',
        comoResolver: 'Veja a saúde do canal em Configurações → Canais.',
      }
    case 'ia_falhou':
      return {
        curto: 'a IA não conseguiu escrever',
        explicacao:
          'A assistente falhou ao escrever a mensagem — quase sempre é a chave da IA sem saldo ou o provedor fora do ar.',
        comoResolver: 'Confira o saldo e a chave da IA em Agentes → Credenciais.',
      }
    case 'sem_ia':
      return {
        curto: 'agente sem IA configurada',
        explicacao:
          'Não há uma configuração de IA utilizável para escrever o lembrete deste compromisso.',
        comoResolver: 'Confira se o agente está ativo e com a chave preenchida em Agentes.',
      }
    case 'sem_paciente':
      return {
        curto: 'sem cliente/paciente',
        explicacao:
          'A consulta está marcada no nome de alguém, mas não há ninguém do cadastro ligado a ela — em geral porque falta o telefone na agenda de origem.',
        comoResolver:
          'Abra o compromisso e preencha o campo "Cliente / paciente", ou cadastre o telefone no sistema de onde a agenda vem.',
      }
  }
}

/**
 * Quanto tempo um degrau travado continua sendo tentado depois da hora dele.
 *
 * Seis horas é o tempo de alguém religar a IA, escolher o template ou o número
 * voltar do ar. Passado isso, insistir não recupera mais nada — e cada evento
 * preso ocupa uma das 40 vagas por agente (`PER_AGENT_CAP`) na varredura.
 */
export const RECUPERACAO_MS = 6 * 60 * 60 * 1000

/**
 * Segurar o degrau ou encerrar de vez?
 *
 * Segurar é de graça enquanto ainda existe degrau futuro: a varredura só tenta
 * o vencido MAIS RECENTE, então o preso é naturalmente substituído. O risco
 * aparece no ÚLTIMO degrau — aí o evento fica na fila até a janela da consulta
 * expirar, e num dia em que o canal caiu os travados de ontem empurrariam os
 * avisos de amanhã para fora do limite (numa clínica com 10 profissionais isso
 * é dezenas de consultas por dia). Seria trocar um buraco por outro.
 *
 * `encerra` não apaga o aviso: o motivo continua no compromisso, para quem
 * marcou saber que aquela pessoa não foi avisada.
 */
export function decideImpedimento(args: {
  /** Este é o último degrau configurado? */
  ehUltimoDegrau: boolean
  /** Quanto tempo passou desde a hora em que aquele degrau deveria ter saído. */
  msDesdeODegrau: number
}): 'segura' | 'encerra' {
  if (!args.ehUltimoDegrau) return 'segura'
  return args.msDesdeODegrau > RECUPERACAO_MS ? 'encerra' : 'segura'
}

/**
 * O início do compromisso mudou? Compara até o SEGUNDO, que é o que o Google
 * guarda: um horário do CRM com milissegundos volta do Google sem eles, e isso
 * não é remarcação — zerar ali repetiria para o paciente um degrau que já
 * saiu. Horário ilegível também não conta como mudança, pelo mesmo motivo.
 */
export function mudouOInicio(antes: string | Date, depois: string | Date): boolean {
  const a = Math.floor(new Date(antes).getTime() / 1000)
  const b = Math.floor(new Date(depois).getTime() / 1000)
  return !Number.isNaN(a) && !Number.isNaN(b) && a !== b
}

/** Mesmo minuto? (o horário que a recepção vê e escolhe; o Google pode trazer segundos.) */
function mesmoMinuto(a: string | Date | null | undefined, b: string | Date): boolean {
  if (a === null || a === undefined || a === '') return false
  const ta = new Date(a).getTime()
  const tb = new Date(b).getTime()
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) < 60_000
}

/** Contador vindo do banco (driver pode devolver texto; NULL/lixo = 0). */
function contador(v: number | string | null | undefined): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * Como o compromisso está ANTES de mudar de horário — o que o recomeço do
 * lembrete precisa saber. As duas últimas colunas são da migração 0206; linha
 * lida sem elas (ou de antes dela) vale como "nada guardado".
 */
export type LembreteDoCompromisso = {
  startsAt: string | Date
  /** Degraus já enviados para `startsAt`. */
  remindersSent?: number | string | null
  /** O início para o qual `remindersPrevSent` vale. */
  remindersPrevStartsAt?: string | Date | null
  /** Degraus que já tinham saído para `remindersPrevStartsAt`. */
  remindersPrevSent?: number | string | null
}

/** O que o UPDATE grava quando o início muda (`{}` = o início não mudou). */
export type RecomecoDoLembrete = {
  remindersSent: number
  reminderBlock: null
  reminderBlockAt: null
  remindersPrevStartsAt?: string
  remindersPrevSent?: number
}

/**
 * O compromisso mudou de horário? Então o lembrete recomeça — a não ser que
 * tenha VOLTADO para o horário de antes.
 *
 * É a ÚNICA vez em que `reminders_sent` volta: os degraus que ele conta, e o
 * motivo guardado em `reminder_block`, falavam da data ANTIGA. Sem zerar, a
 * data nova nasce com os degraus queimados e o paciente não recebe nada da
 * remarcação — justamente quando mais precisa ser avisado. A Agenda e a IA já
 * zeravam ao remarcar; o sync do Google não (01/10): a consulta ARRASTADA no
 * Google depois do lembrete de 24h ficava sem lembrete na data nova. E agora
 * pesa em dobro: o contador de um compromisso também cala as cópias dele
 * (meeting-reminder-dedup.ts).
 *
 * 02/10/2026 — moveu e VOLTOU. Zerar sempre fazia a recepção (ou o Google, ou
 * a IA) que mudava 10h→11h e logo desfazia 11h→10h mandar DE NOVO ao paciente
 * o lembrete das 10h que já tinha saído. Agora, antes de zerar, o contador
 * que valia para o início antigo fica guardado (`reminders_prev_*`, migração
 * 0206) — só se havia degrau gasto: contador 0 não tem o que proteger e não
 * apaga o que estava guardado (moveu, moveu de novo e voltou ao primeiro
 * ainda acha o do primeiro). Ao chegar a um início IGUAL, no minuto, ao
 * guardado, o contador volta para o maior dos dois (o de agora e o guardado)
 * em vez de zerar: nenhum degrau que o paciente já recebeu sai de novo. Vale
 * igual com ou sem a confirmação ao agendar — a fila dela compara com o que o
 * paciente sabe e já dá 'semMudanca' no vai-e-volta; isto aqui é só o
 * lembrete. Uma vaga só: o guardado é sempre o do ÚLTIMO início que tinha
 * degrau gasto.
 *
 * Uma regra para os três caminhos que mudam o início — o salvar da Agenda, o
 * import do Google (inclusive o evento remarcado para fora da janela) e o
 * mover do [[AGENDAR]] da IA. Não duplicar em SQL à mão.
 */
export function recomecoDoLembrete(
  antes: LembreteDoCompromisso,
  depois: string | Date,
): RecomecoDoLembrete | Record<string, never> {
  if (!mudouOInicio(antes.startsAt, depois)) return {}
  const atual = contador(antes.remindersSent)
  const guardado = contador(antes.remindersPrevSent)
  const voltou = guardado > 0 && mesmoMinuto(antes.remindersPrevStartsAt, depois)
  return {
    remindersSent: voltou ? Math.max(atual, guardado) : 0,
    reminderBlock: null,
    reminderBlockAt: null,
    ...(atual > 0
      ? { remindersPrevStartsAt: new Date(antes.startsAt).toISOString(), remindersPrevSent: atual }
      : {}),
  }
}

/**
 * Aviso de uma linha para o compromisso na Agenda.
 *
 * Nunca diz só "erro": diz que o PACIENTE não será avisado, que é a
 * consequência que importa para quem está olhando.
 *
 * 01/10: dizia "a confirmação". Agora "confirmação" é a mensagem que sai NA
 * HORA de agendar (lib/agenda/confirmacao-agendamento.ts), e os dois avisos se
 * contradiziam ("Confirmação enviada" ao salvar, "não vai receber a
 * confirmação" no compromisso). Isto aqui é do LEMBRETE.
 */
export function avisoNaAgenda(motivo: MeetingReminderBlock): string {
  return `Este contato não vai receber o lembrete — ${rotuloDoBloqueio(motivo).curto}.`
}
