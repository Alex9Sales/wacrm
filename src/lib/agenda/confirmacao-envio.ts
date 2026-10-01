// ============================================================
// ✅ Confirmação na hora de agendar — o envio.
//
// Chamado SÓ pelas ações da Agenda (createEvent/updateEvent), quando uma
// pessoa salvou o compromisso no CRM com a caixa "Enviar confirmação ao
// paciente" marcada. Nunca pelo import do Google (o sync grava direto no
// banco) nem pelo [[AGENDAR]] da IA (ela já confirma na própria conversa).
// A decisão e o texto moram em `confirmacao-agendamento.ts`.
//
// Best-effort e nunca lança: o compromisso já foi gravado quando isto roda, e
// falhar a confirmação não pode desfazer nem "falhar" o salvamento. Mas também
// não engole: devolve o motivo para o modal mostrar (01/10/2026).
// ============================================================

import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'

import { db, calendars, calendarEvents, channels, contacts, conversations, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { CAPABILITIES, type ProviderId } from '@/lib/channels/provider'
import { jaFoiEntregue } from '@/lib/channels/delivery-error'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { SendMessageError, sendMessageToConversation } from '@/lib/whatsapp/send-message'
import {
  FUSO_PADRAO,
  decidirConfirmacao,
  textoDaConfirmacao,
  type ResultadoConfirmacao,
  type TipoConfirmacao,
} from './confirmacao-agendamento'

/** Canais de WhatsApp. A caixa diz "pelo WhatsApp": Instagram e e-mail ficam de fora. */
const WHATSAPP: ProviderId[] = ['meta', 'waha', 'evolution', 'evogo']
const JANELA_MS = 24 * 60 * 60 * 1000

const naoEnviada = (motivo: string): ResultadoConfirmacao => ({ naoEnviada: motivo })

/**
 * O erro do envio em português de recepção. O texto amigável que
 * `friendlySendError` já monta passa direto; o resto vira uma frase curta (o
 * erro cru fica no log).
 */
function motivoDoErro(err: unknown): string {
  if (err instanceof SendMessageError) {
    if (err.code === 'whatsapp_not_configured') return 'nenhum WhatsApp conectado nesta conta'
    if (/phone/i.test(err.message)) return 'o telefone do paciente não é um número de WhatsApp válido'
    if (err.code === 'not_found') return 'a conversa do paciente não foi encontrada'
    // friendlySendError: frase pronta em português ("O WhatsApp recusou…").
    if (err.code === 'send_error' && !/send error:/i.test(err.message)) {
      return err.message.replace(/\.$/, '').replace(/^\p{Lu}/u, (c) => c.toLowerCase())
    }
    if (err.code === 'send_error') return 'o WhatsApp recusou o envio (confira se o canal está conectado)'
  }
  return 'o envio falhou'
}

/** A conversa de WhatsApp por onde a confirmação sai. null = não há. */
async function conversaDoPaciente(
  accountId: string,
  contactId: string,
  pedida: string | null,
): Promise<{ id: string; provider: string | null } | null> {
  const ehWhatsApp = or(isNull(conversations.channelId), inArray(channels.provider, WHATSAPP))
  // A conversa de onde a recepção clicou "Agendar" — se ainda for DESTE
  // paciente. Quem trocou o paciente no modal depois de vir da conversa da
  // Ana não pode mandar a consulta do João na conversa da Ana.
  if (pedida) {
    const c = firstOrNull(
      await db
        .select({ id: conversations.id, provider: channels.provider })
        .from(conversations)
        .leftJoin(channels, eq(channels.id, conversations.channelId))
        .where(
          and(
            eq(conversations.id, pedida),
            eq(conversations.accountId, accountId),
            eq(conversations.contactId, contactId),
            ehWhatsApp,
          ),
        )
        .limit(1),
    )
    if (c) return c
  }
  // Senão, a conversa de WhatsApp mais recente do paciente nesta conta (a
  // mesma escolha do lembrete: a que tem a última mensagem).
  return firstOrNull(
    await db
      .select({ id: conversations.id, provider: channels.provider })
      .from(conversations)
      .leftJoin(channels, eq(channels.id, conversations.channelId))
      .where(and(eq(conversations.accountId, accountId), eq(conversations.contactId, contactId), ehWhatsApp))
      .orderBy(sql`${conversations.lastMessageAt} DESC NULLS LAST`)
      .limit(1),
  )
}

/**
 * Manda a confirmação do compromisso `eventId` (já gravado) ao paciente.
 * Devolve 'enviada' ou o motivo de não ter ido. Nunca lança.
 */
export async function enviarConfirmacaoDoAgendamento(args: {
  accountId: string
  eventId: string
  tipo: TipoConfirmacao
  /** Conversa de onde a pessoa veio (botão "Agendar" da conversa). */
  conversationId?: string | null
  agora?: Date
}): Promise<ResultadoConfirmacao> {
  const { accountId, eventId, tipo } = args
  const agora = args.agora ?? new Date()
  try {
    const settings = await getAccountSettings(accountId)
    // A caixa só aparece com a opção ligada; chegar aqui com ela desligada é
    // tela aberta antes de alguém desligar. Avisa em vez de calar.
    if (settings.bookingConfirmation !== true) {
      return naoEnviada('a confirmação ao agendar está desligada nesta conta')
    }

    const ev = firstOrNull(
      await db
        .select({
          status: calendarEvents.status,
          startsAt: calendarEvents.startsAt,
          endsAt: calendarEvents.endsAt,
          allDay: calendarEvents.allDay,
          contactId: calendarEvents.contactId,
          calendarName: calendars.name,
          contactName: contacts.name,
          isGroup: contacts.isGroup,
          optedOut: contacts.optedOut,
        })
        .from(calendarEvents)
        .leftJoin(
          calendars,
          and(eq(calendars.id, calendarEvents.calendarId), eq(calendars.accountId, accountId)),
        )
        .leftJoin(
          contacts,
          and(eq(contacts.id, calendarEvents.contactId), eq(contacts.accountId, accountId)),
        )
        .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.accountId, accountId)))
        .limit(1),
    )
    if (!ev) return naoEnviada('o compromisso não foi encontrado')

    const decisao = decidirConfirmacao({
      evento: ev,
      contato:
        ev.contactId && ev.isGroup !== null && ev.optedOut !== null
          ? { isGroup: ev.isGroup, optedOut: ev.optedOut }
          : null,
      agora,
    })
    if (!decisao.envia) return naoEnviada(decisao.motivo)
    const contactId = ev.contactId as string

    // A recepção às vezes lança a mesma consulta em duas agendas (a da dona e a
    // do profissional — ver meeting-reminder-dedup.ts), ou salva duas vezes.
    // Duas confirmações, uma "com a Dra. Joyce" e outra "com o Dr. Igor",
    // deixariam o paciente sem saber com quem é. A segunda não sai, e o modal
    // diz por quê.
    const copia = firstOrNull(
      await db
        .select({ id: calendarEvents.id })
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.accountId, accountId),
            eq(calendarEvents.contactId, contactId),
            eq(calendarEvents.startsAt, ev.startsAt),
            eq(calendarEvents.status, 'confirmed'),
            ne(calendarEvents.id, eventId),
          ),
        )
        .limit(1),
    )
    if (copia) {
      return naoEnviada(
        'este paciente já tem outro compromisso neste mesmo horário (talvez em outra agenda); para não mandar duas mensagens, esta não foi enviada',
      )
    }

    const conversa = await conversaDoPaciente(accountId, contactId, args.conversationId ?? null)
    if (!conversa) return naoEnviada('o paciente não tem conversa de WhatsApp com a clínica')

    // WhatsApp oficial (Meta): texto livre só até 24h depois da última
    // mensagem do paciente. Fora disso a Meta recusa — e a confirmação não tem
    // template próprio (ainda). Mesma regra do lembrete (followup.ts).
    if (conversa.provider && CAPABILITIES[conversa.provider as ProviderId]?.templates === true) {
      const ultima = firstOrNull(
        await db
          .select({ at: sql<string | null>`max(${messages.createdAt})` })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversa.id),
              eq(messages.senderType, 'customer'),
              eq(messages.isInternal, false),
            ),
          ),
      )
      const ms = ultima?.at ? new Date(ultima.at).getTime() : 0
      if (!ms || agora.getTime() - ms >= JANELA_MS) {
        return naoEnviada(
          'no WhatsApp oficial só dá para mandar mensagem livre até 24h depois da última mensagem do paciente',
        )
      }
    }

    const texto = textoDaConfirmacao({
      tipo,
      nomeContato: ev.contactName,
      nomeAgenda: ev.calendarName,
      startsAt: ev.startsAt,
      allDay: ev.allDay,
      tz: settings.businessTimezone || FUSO_PADRAO,
    })

    try {
      // senderType 'bot': gravada como mensagem automática, igual ao lembrete
      // de consulta (engineSendText grava 'bot'). Como 'agent' ela seria lida
      // como atendente respondendo: a IA recuaria pelo barge-in e o fluxo
      // ativo do contato seria pausado por uma mensagem que ninguém digitou.
      await sendMessageToConversation(accountId, {
        conversationId: conversa.id,
        messageType: 'text',
        contentText: texto,
        senderType: 'bot',
      })
      return 'enviada'
    } catch (err) {
      // "A chamada lançou" não é "não chegou" (delivery-error.ts): o WhatsApp
      // aceitou e só a gravação falhou. Dizer "não enviada" aqui levaria a
      // recepção a mandar de novo para quem já recebeu.
      if (jaFoiEntregue(err) || (err instanceof SendMessageError && err.code === 'db_error')) {
        console.error('[agenda] confirmação entregue mas não registrada:', err)
        return 'enviada'
      }
      console.error('[agenda] confirmação ao paciente falhou:', err)
      return naoEnviada(motivoDoErro(err))
    }
  } catch (err) {
    console.error('[agenda] confirmação ao paciente falhou (antes do envio):', err)
    return naoEnviada('não foi possível preparar a confirmação agora')
  }
}
