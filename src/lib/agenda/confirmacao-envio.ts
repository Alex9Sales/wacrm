// ============================================================
// ✅ Confirmação na hora de agendar — o envio.
//
// Chamado SÓ pela fila da confirmação (`confirmacao-fila.ts`, worker
// booking-confirmation), que só existe quando uma pessoa salvou o compromisso
// no CRM com a caixa "Enviar confirmação ao paciente" marcada. Nunca pelo
// import do Google (o sync grava direto no banco) nem pelo [[AGENDAR]] da IA
// (ela já confirma na própria conversa). A decisão e o texto moram em
// `confirmacao-agendamento.ts`.
//
// 02/10: até aqui as actions chamavam isto NA HORA de cada salvar, e um
// compromisso corrigido duas vezes mandava três mensagens ao paciente. Agora
// o worker chama uns minutos depois do último salvar, com o tipo já calculado
// contra o que o paciente sabe. Tudo aqui é re-checado no estado FINAL.
//
// Best-effort e nunca lança: o compromisso já foi gravado quando isto roda, e
// falhar a confirmação não pode desfazer nem "falhar" o salvamento. Mas também
// não engole: devolve o motivo (01/10/2026), que a fila grava no compromisso e
// anota na conversa.
// ============================================================

import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'

import { db, aiConfigs, calendars, calendarEvents, channels, contacts, conversations, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { degrausJaVencidos, lembretesDoCompromisso } from '@/lib/ai/followup'
import { setCoveredUntil } from '@/lib/ai/reply-marker'
import { CAPABILITIES, type ProviderId } from '@/lib/channels/provider'
import { jaFoiEntregue } from '@/lib/channels/delivery-error'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { ensureConversationForContact } from '@/lib/whatsapp/resolve-conversation'
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
/**
 * WhatsApp não oficial: o único que pode COMEÇAR uma conversa com texto livre.
 * O oficial (Meta) só começa com template aprovado, e a confirmação não tem um.
 */
const WHATSAPP_NAO_OFICIAL: ProviderId[] = ['waha', 'evolution', 'evogo']
const JANELA_MS = 24 * 60 * 60 * 1000

const naoEnviada = (motivo: string): ResultadoConfirmacao => ({ naoEnviada: motivo })

/**
 * 01/10, revisão: o WAHA aborta a chamada em 15s ("This operation was
 * aborted"), e às vezes entrega mesmo assim; "no message id" é resposta sem o
 * id da mensagem. Nos dois casos ninguém sabe se o paciente recebeu — dizer
 * "o WhatsApp recusou" levava a recepção a digitar de novo para quem já tinha
 * a mensagem.
 */
const INCERTO = /abort|timeout|timed out|deadline|no message id|demorou demais/i
const MOTIVO_INCERTO = 'não deu para confirmar se a mensagem saiu; confira a conversa antes de reenviar'

/**
 * O erro do envio em português de recepção. O texto amigável que
 * `friendlySendError` já monta passa direto; o resto vira uma frase curta (o
 * erro cru fica no log). Resultado incerto vira `incerta`, nunca "recusou".
 */
function resultadoDoErro(err: unknown): ResultadoConfirmacao {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if ((err instanceof Error && err.name === 'AbortError') || INCERTO.test(msg)) {
    return { incerta: MOTIVO_INCERTO }
  }
  if (err instanceof SendMessageError) {
    if (err.code === 'whatsapp_not_configured') return naoEnviada('nenhum WhatsApp conectado nesta conta')
    if (/phone/i.test(err.message)) return naoEnviada('o telefone do paciente não é um número de WhatsApp válido')
    if (err.code === 'not_found') return naoEnviada('a conversa do paciente não foi encontrada')
    // friendlySendError: frase pronta em português ("O WhatsApp recusou…").
    if ((err.code === 'send_error' || err.code === 'channel_disconnected') && !/send error:/i.test(err.message)) {
      return naoEnviada(err.message.replace(/\.$/, '').replace(/^\p{Lu}/u, (c) => c.toLowerCase()))
    }
    if (err.code === 'send_error') return naoEnviada('o WhatsApp recusou o envio (confira se o canal está conectado)')
  }
  return naoEnviada('o envio falhou')
}

/**
 * A conversa de WhatsApp por onde a confirmação sai. null = não há.
 * Exportada para a fila anotar ali o aviso de "não enviada" (02/10).
 */
export async function conversaDoPaciente(
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
 * Paciente sem conversa de WhatsApp — o caso que motivou o pedido (01/10,
 * revisão): "tem muita gente que agenda aqui [no balcão], sai e fala: manda no
 * WhatsApp". Abre a conversa como a régua de cobrança abre para quem nunca
 * escreveu (ensureConversationForContact), num WhatsApp NÃO oficial conectado:
 * de preferência um número em que a IA atende (é por ele que a clínica conversa
 * e que a resposta do paciente vai ser lida), senão o conectado mais recente.
 * Canal dedicado a uma pessoa da equipe fica por último.
 */
async function abrirConversa(
  accountId: string,
  contactId: string,
  telefone: string | null,
): Promise<{ id: string; provider: string | null } | { naoEnviada: string }> {
  const digitos = (telefone ?? '').replace(/\D/g, '')
  if (digitos.length < 10) {
    return { naoEnviada: 'o paciente não tem conversa de WhatsApp com a clínica nem telefone cadastrado' }
  }
  const canais = await db
    .select({
      id: channels.id,
      provider: channels.provider,
      status: channels.status,
      dedicatedUserId: channels.dedicatedUserId,
    })
    .from(channels)
    .where(and(eq(channels.accountId, accountId), inArray(channels.provider, WHATSAPP)))
    .orderBy(desc(channels.createdAt))
  const livres = canais.filter(
    (c) => c.status === 'connected' && (WHATSAPP_NAO_OFICIAL as string[]).includes(c.provider),
  )
  if (livres.length === 0) {
    const soOficial = canais.some((c) => c.status === 'connected' && c.provider === 'meta')
    return {
      naoEnviada: soOficial
        ? 'o paciente ainda não tem conversa com a clínica, e o WhatsApp oficial só começa conversa com modelo aprovado (template), que a confirmação não tem'
        : 'o paciente ainda não tem conversa com a clínica e nenhum número de WhatsApp está conectado para começar uma',
    }
  }
  // Números em que a IA atende (agentes ativos com lista de canais).
  const daIa = new Set<string>()
  for (const a of await db
    .select({ ids: aiConfigs.autoReplyChannelIds })
    .from(aiConfigs)
    .where(and(eq(aiConfigs.accountId, accountId), eq(aiConfigs.isActive, true)))) {
    for (const id of a.ids ?? []) daIa.add(id)
  }
  const peso = (c: (typeof livres)[number]) => (daIa.has(c.id) ? 0 : 2) + (c.dedicatedUserId ? 1 : 0)
  // sort é estável: no empate fica a ordem do SELECT (o mais recente primeiro).
  const canal = [...livres].sort((a, b) => peso(a) - peso(b))[0]
  const { conversationId } = await ensureConversationForContact(accountId, contactId, canal.id)
  return { id: conversationId, provider: canal.provider }
}

/**
 * Degrau "antes" que vence nas próximas 3h também fica coberto pela
 * confirmação (01/10, 2ª revisão): marcar às 9h50 o retorno de amanhã às 10h
 * soltava o lembrete "é amanhã" dez minutos depois de "está confirmada".
 */
const FOLGA_DO_LEMBRETE_MS = 3 * 60 * 60 * 1000
/** Paciente que escreveu há menos que isso ainda pode estar esperando a IA. */
const RESPOSTA_PENDENTE_MS = 5 * 60 * 1000

type Reserva = { n: number; anteriores: { id: string; antes: number }[] }

/**
 * Reserva, ANTES de enviar, os degraus de lembrete que a confirmação cobre: o
 * deste compromisso e o das cópias dele (mesma conta, contato e horário,
 * confirmadas). Antes era gravado DEPOIS do envio, e a varredura de lembretes
 * (de minuto em minuto) que caísse nesses segundos mandava os dois (01/10, 2ª
 * revisão). GREATEST: nunca volta. Devolve os valores de antes para desfazer
 * se a confirmação não sair.
 */
async function reservarLembretes(args: {
  accountId: string
  eventId: string
  startsAt: string
  agora: Date
}): Promise<Reserva | null> {
  try {
    const degraus = await lembretesDoCompromisso(args.accountId, args.eventId)
    const n = degrausJaVencidos(degraus, args.startsAt, new Date(args.agora.getTime() + FOLGA_DO_LEMBRETE_MS))
    if (n <= 0) return null
    const res = await db.execute(sql`
      WITH alvo AS (
        SELECT d.id, d.reminders_sent AS antes
          FROM calendar_events AS d
          JOIN calendar_events AS e ON e.id = ${args.eventId} AND e.account_id = ${args.accountId}
         WHERE d.account_id = e.account_id
           AND (d.id = e.id
                OR (d.contact_id = e.contact_id
                    AND d.starts_at = e.starts_at
                    AND d.status = 'confirmed'))
           FOR UPDATE OF d
      )
      UPDATE calendar_events AS u
         SET reminders_sent = GREATEST(u.reminders_sent, ${n}),
             reminder_block = NULL,
             reminder_block_at = NULL
        FROM alvo
       WHERE u.id = alvo.id
      RETURNING u.id, alvo.antes
    `)
    const anteriores = (res.rows as { id: string; antes: number | string }[]).map((r) => ({
      id: r.id,
      antes: Number(r.antes),
    }))
    return { n, anteriores }
  } catch (err) {
    console.error('[agenda] confirmação: reservar os lembretes cobertos falhou:', err)
    return null
  }
}

/**
 * A confirmação NÃO saiu (ou não se sabe): devolve os degraus. Compare-and-swap
 * — só volta quem ainda está no valor que a reserva gravou; se a varredura já
 * andou por conta própria, fica como ela deixou. Na dúvida, o lembrete sai:
 * lembrete a mais é melhor que paciente sem aviso.
 */
async function desfazerReserva(reserva: Reserva | null): Promise<void> {
  if (!reserva) return
  for (const r of reserva.anteriores) {
    if (r.antes >= reserva.n) continue
    try {
      await db.execute(sql`
        UPDATE calendar_events
           SET reminders_sent = ${r.antes}
         WHERE id = ${r.id}
           AND reminders_sent = ${reserva.n}
      `)
    } catch (err) {
      console.error('[agenda] confirmação: devolver o lembrete reservado falhou:', err)
    }
  }
}

/**
 * Depois de a confirmação SAIR (inclusive "entregue mas não gravada").
 * Best-effort: o paciente já recebeu, nada aqui pode virar erro.
 *
 * A confirmação é gravada como 'bot' (como o lembrete). Com 'bot' por último,
 * o auto-reply lê "fui eu que falei" e podia responder mensagem antiga que a
 * recepção já tinha atendido (auto-reply.ts, "humano falou por último" e
 * dropIfStale). Marcar a conversa como coberta diz: o que veio antes já foi
 * atendido. MAS só se o paciente não escreveu agora há pouco — senão a
 * pergunta que a IA ia responder ("e quanto custa?") ficava sem resposta
 * (01/10, 2ª revisão).
 */
async function depoisDeEnviar(args: { conversationId: string; agora: Date }): Promise<void> {
  try {
    const ultima = firstOrNull(
      await db
        .select({ at: sql<string | null>`max(${messages.createdAt})` })
        .from(messages)
        .where(and(eq(messages.conversationId, args.conversationId), eq(messages.senderType, 'customer'))),
    )
    const ms = ultima?.at ? new Date(ultima.at).getTime() : 0
    if (ms && args.agora.getTime() - ms < RESPOSTA_PENDENTE_MS) return
    await setCoveredUntil(args.conversationId, new Date())
  } catch (err) {
    console.error('[agenda] confirmação: marcar a conversa como atendida falhou:', err)
  }
}

/**
 * Manda a confirmação do compromisso `eventId` (já gravado) ao paciente.
 * Devolve 'enviada', o motivo de não ter ido, ou `incerta`. Nunca lança.
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
          // De onde veio o nome: perfil do WhatsApp não é nome (nomeParaSaudacao).
          nameSource: contacts.nameSource,
          contactPhone: contacts.phone,
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
    // diz por quê — sem afirmar que a outra mandou, porque não sabemos (ela
    // pode ter sido salva com a caixa desmarcada, ou vindo do Google).
    //
    // Cópia com a confirmação AINDA NA FILA não conta (02/10): com a fila, as
    // duas cópias lançadas pela recepção ficam pendentes juntas, e cada uma via
    // a outra e desistia — o paciente ficava sem nenhuma. A que o worker pega
    // primeiro manda; quando a outra chegar, a primeira já saiu da fila e a
    // regra acima vale.
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
            isNull(calendarEvents.confirmationDueAt),
          ),
        )
        .limit(1),
    )
    if (copia) {
      return naoEnviada(
        'este paciente já tem outro compromisso neste mesmo horário; para não mandar duas mensagens, esta não foi enviada — confira a conversa',
      )
    }

    const existente = await conversaDoPaciente(accountId, contactId, args.conversationId ?? null)
    const alvo = existente ?? (await abrirConversa(accountId, contactId, ev.contactPhone))
    if ('naoEnviada' in alvo) return alvo
    const conversa: { id: string; provider: string | null } = alvo
    if (existente && conversa.provider && CAPABILITIES[conversa.provider as ProviderId]?.templates === true) {
      // WhatsApp oficial (Meta): texto livre só até 24h depois da última
      // mensagem do paciente. Fora disso a Meta recusa — e a confirmação não
      // tem template próprio (ainda). Mesma regra do lembrete (followup.ts).
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
      nameSource: ev.nameSource,
      nomeAgenda: ev.calendarName,
      startsAt: ev.startsAt,
      allDay: ev.allDay,
      tz: settings.businessTimezone || FUSO_PADRAO,
    })

    const depois = () => depoisDeEnviar({ conversationId: conversa.id, agora })
    // Reserva os degraus cobertos ANTES de enviar (ver reservarLembretes).
    const reserva = await reservarLembretes({ accountId, eventId, startsAt: ev.startsAt, agora })
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
      await depois()
      return 'enviada'
    } catch (err) {
      // "A chamada lançou" não é "não chegou" (delivery-error.ts): o WhatsApp
      // aceitou e só a gravação falhou. Dizer "não enviada" aqui levaria a
      // recepção a mandar de novo para quem já recebeu.
      if (jaFoiEntregue(err) || (err instanceof SendMessageError && err.code === 'db_error')) {
        console.error('[agenda] confirmação entregue mas não registrada:', err)
        await depois()
        return 'enviada'
      }
      console.error('[agenda] confirmação ao paciente falhou:', err)
      // Não saiu, ou não se sabe se saiu: o lembrete volta a valer.
      await desfazerReserva(reserva)
      return resultadoDoErro(err)
    }
  } catch (err) {
    console.error('[agenda] confirmação ao paciente falhou (antes do envio):', err)
    return naoEnviada('não foi possível preparar a confirmação agora')
  }
}
