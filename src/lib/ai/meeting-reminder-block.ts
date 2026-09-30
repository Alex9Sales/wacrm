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

const MOTIVOS: MeetingReminderBlock[] = [
  'sem_conversa',
  'ia_pausada',
  'sem_template',
  'template_falhou',
  'sem_historico',
  'envio_falhou',
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
          'Este contato não tem nenhuma conversa aberta, então não há por onde mandar a confirmação.',
        comoResolver: 'Mande uma mensagem para ele uma vez — a partir daí o lembrete sai sozinho.',
      }
    case 'ia_pausada':
      return {
        curto: 'IA pausada nesta conversa',
        explicacao:
          'A assistente foi desligada na conversa deste contato, e lembrete não sai onde alguém desligou a IA de propósito.',
        comoResolver: 'Reative a IA na conversa, se quiser que ele receba a confirmação.',
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
 * avisos de amanhã para fora do limite. Isso seria trocar um buraco por outro.
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
 * Aviso de uma linha para o compromisso na Agenda.
 *
 * Nunca diz só "erro": diz que o PACIENTE não será avisado, que é a
 * consequência que importa para quem está olhando.
 */
export function avisoNaAgenda(motivo: MeetingReminderBlock): string {
  return `Este contato não vai receber a confirmação — ${rotuloDoBloqueio(motivo).curto}.`
}
