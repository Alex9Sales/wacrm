// ============================================================
// ⏳ Confirmação ao agendar — a FILA (02/10/2026).
//
// Até 01/10 cada "Salvar" na Agenda mandava a confirmação ao paciente na
// hora. Nas primeiras horas em produção, numa clínica odontológica: o
// compromisso criado no horário errado e corrigido em seguida mandou três
// mensagens seguidas ("confirmada às 18h", "remarcada para 18h30", outra), e a
// troca de profissional depois de uma confirmação "com a Dra." errada não
// avisou ninguém.
//
// Agora:
//   - o salvar (actions da Agenda) só PÕE NA FILA — `agendarConfirmacao`:
//     confere na hora o que já dá para saber (sem paciente, horário passado,
//     "não perturbe", grupo) e marca `confirmation_due_at` = agora + 3 min.
//     Salvar de novo empurra a saída; desmarcar a caixa tira da fila
//     (`descartarConfirmacaoPendente`);
//   - o worker booking-confirmation (tick de 30 s) pega as vencidas —
//     `processarConfirmacoesVencidas` —, lê o estado FINAL do compromisso,
//     compara com o que o paciente já sabe (`confirmation_known`) e manda UMA
//     mensagem, a certa (`confirmacao-envio.ts` re-checa tudo e reserva os
//     lembretes). Moveu e voltou: não manda nada.
//   - o que não saiu fica no compromisso (`confirmation_result`, a Agenda
//     mostra) e numa nota interna na conversa do paciente: a recepção já saiu
//     do modal quando o worker tenta, um toast não chegaria a ninguém.
//
// Sem 'server-only': o worker importa isto (o worker não tem esse pacote).
// SQL cru: nada de interpolação depois de "--" (comentário SQL engole o resto
// da linha — ver o incidente do lembrete de 30/09).
// ============================================================

import { and, eq, sql } from 'drizzle-orm'

import { db, calendars, calendarEvents, contacts, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getAccountSettings } from '@/lib/settings/account-settings'
import {
  ATRASO_DA_CONFIRMACAO_MS,
  FUSO_PADRAO,
  baseDaConfirmacao,
  decidirConfirmacao,
  decidirNaFila,
  desfechoDoEnvio,
  isConfirmacaoConhecida,
  notaDaConfirmacaoQueNaoSaiu,
  tipoDaConfirmacaoNaEdicao,
  type ConfirmacaoConhecida,
  type ConfirmacaoNaTela,
  type DesfechoDaConfirmacao,
} from './confirmacao-agendamento'
import { conversaDoPaciente, enviarConfirmacaoDoAgendamento } from './confirmacao-envio'

/** Quantas confirmações vencidas um tick pega. Cada uma é um envio de WhatsApp. */
export const LOTE_DA_FILA = 20

/**
 * Motivo que o envio devolve quando o compromisso sumiu (apagado no meio do
 * envio). Não vira nota: foi a própria recepção que apagou.
 */
const MOTIVO_SUMIU = 'o compromisso não foi encontrado'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Nome da agenda (para "com a Dra. X" e para saber se trocou o profissional). */
async function nomeDaAgenda(accountId: string, calendarId: string): Promise<string | null> {
  const c = firstOrNull(
    await db
      .select({ name: calendars.name })
      .from(calendars)
      .where(and(eq(calendars.id, calendarId), eq(calendars.accountId, accountId)))
      .limit(1),
  )
  return c?.name ?? null
}

/**
 * Tira da fila e grava o porquê. Usado quando o salvar já sabe que a
 * confirmação não pode sair: o worker diria o mesmo minutos depois, com uma
 * nota na conversa repetindo o aviso que o modal acabou de dar. Best-effort:
 * falhar aqui não pode trocar o motivo de verdade por "não foi possível".
 */
async function tirarDaFila(accountId: string, eventId: string, desfecho: DesfechoDaConfirmacao): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE calendar_events
         SET confirmation_due_at = NULL,
             confirmation_conversation_id = NULL,
             confirmation_result = ${JSON.stringify(desfecho)}::jsonb
       WHERE id = ${eventId}
         AND account_id = ${accountId}
    `)
  } catch (err) {
    console.error('[agenda] confirmação: tirar da fila falhou:', err)
  }
}

// ---------- O lado do salvar (actions da Agenda) ----------

/**
 * O salvar pediu a confirmação (caixa marcada): põe na fila, ou diz na hora
 * por que não vai. Devolve o que o modal mostra. Nunca lança.
 *
 * `antes` é o compromisso como estava ANTES deste salvar (null = compromisso
 * novo): numa edição sem nada pendente e sem base, é o que o paciente sabia —
 * vira `confirmation_known`, e o worker manda "remarcada" / "agora é com".
 */
export async function agendarConfirmacao(args: {
  accountId: string
  eventId: string
  antes: ConfirmacaoConhecida | null
  /** Conversa de onde a recepção clicou "Agendar". */
  conversationId?: string | null
  agora?: Date
}): Promise<ConfirmacaoNaTela> {
  const { accountId, eventId } = args
  const agora = args.agora ?? new Date()
  try {
    const settings = await getAccountSettings(accountId)
    // A caixa só aparece com a opção ligada; chegar aqui com ela desligada é
    // tela aberta antes de alguém desligar. Avisa em vez de calar.
    if (settings.bookingConfirmation !== true) {
      const motivo = 'a confirmação ao agendar está desligada nesta conta'
      await tirarDaFila(accountId, eventId, { status: 'naoEnviada', motivo, at: agora.toISOString() })
      return { naoEnviada: motivo }
    }

    const ev = firstOrNull(
      await db
        .select({
          status: calendarEvents.status,
          startsAt: calendarEvents.startsAt,
          endsAt: calendarEvents.endsAt,
          allDay: calendarEvents.allDay,
          calendarId: calendarEvents.calendarId,
          contactId: calendarEvents.contactId,
          calendarName: calendars.name,
          isGroup: contacts.isGroup,
          optedOut: contacts.optedOut,
          dueAt: calendarEvents.confirmationDueAt,
          known: calendarEvents.confirmationKnown,
        })
        .from(calendarEvents)
        .leftJoin(calendars, and(eq(calendars.id, calendarEvents.calendarId), eq(calendars.accountId, accountId)))
        .leftJoin(contacts, and(eq(contacts.id, calendarEvents.contactId), eq(contacts.accountId, accountId)))
        .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.accountId, accountId)))
        .limit(1),
    )
    if (!ev) return { naoEnviada: MOTIVO_SUMIU }

    // O que dá para saber já: sem paciente, cancelado, horário passado, grupo,
    // "não perturbe". Diz no modal, agora, e não deixa nada na fila.
    const decisao = decidirConfirmacao({
      evento: ev,
      contato:
        ev.contactId && ev.isGroup !== null && ev.optedOut !== null
          ? { isGroup: ev.isGroup, optedOut: ev.optedOut }
          : null,
      agora,
    })
    if (!decisao.envia) {
      await tirarDaFila(accountId, eventId, { status: 'naoEnviada', motivo: decisao.motivo, at: agora.toISOString() })
      return { naoEnviada: decisao.motivo }
    }

    // Mudou algo que o paciente precisa saber, comparado com o que ele já sabe?
    // Mesma regra do modal (baseDaConfirmacao). Corrigir o título não manda
    // nada; o que já estiver na fila segue como está.
    const base = baseDaConfirmacao({
      conhecido: isConfirmacaoConhecida(ev.known) ? ev.known : null,
      pendente: ev.dueAt !== null,
      atual: args.antes,
    })
    if (base) {
      const tipo = tipoDaConfirmacaoNaEdicao({
        antes: {
          ...base,
          nomeAgenda: base.calendarId === ev.calendarId ? ev.calendarName : await nomeDaAgenda(accountId, base.calendarId),
        },
        depois: {
          startsAt: ev.startsAt,
          calendarId: ev.calendarId,
          contactId: ev.contactId,
          nomeAgenda: ev.calendarName,
        },
      })
      if (!tipo) return null
    }

    const conversa = args.conversationId && UUID.test(args.conversationId) ? args.conversationId : null
    // known: numa EDIÇÃO sem nada pendente e sem base gravada, o paciente sabia
    // do compromisso como estava antes deste salvar (o mesmo que o modal
    // supõe). Pendente ou base já gravada: fica como está — o CASE decide no
    // próprio UPDATE, sem janela para o worker gravar no meio. Compromisso
    // novo: `antes` null, fica NULL (marcação).
    // result: limpo — o que vale agora é o pendente novo.
    const res = await db.execute(sql`
      UPDATE calendar_events
         SET confirmation_due_at = now() + ${ATRASO_DA_CONFIRMACAO_MS}::int * interval '1 millisecond',
             confirmation_conversation_id = COALESCE(${conversa}::uuid, confirmation_conversation_id),
             confirmation_known = CASE
                 WHEN confirmation_due_at IS NULL AND confirmation_known IS NULL
                 THEN ${args.antes ? JSON.stringify(args.antes) : null}::jsonb
                 ELSE confirmation_known
               END,
             confirmation_result = NULL
       WHERE id = ${eventId}
         AND account_id = ${accountId}
      RETURNING confirmation_due_at::text AS due_at
    `)
    const due = (res.rows[0] as { due_at?: string | null } | undefined)?.due_at
    if (!due) return { naoEnviada: MOTIVO_SUMIU }
    return { agendada: new Date(due).toISOString() }
  } catch (err) {
    console.error('[agenda] confirmação: pôr na fila falhou:', err)
    return { naoEnviada: 'não foi possível agendar a confirmação agora' }
  }
}

/**
 * A caixa estava NA TELA e foi desmarcada: a recepção decidiu que esta
 * mudança não vai ao paciente. Tira o que estiver na fila e grava o estado
 * atual como base (`confirmation_known`) — a próxima confirmação fala do que
 * mudar DAQUI em diante, igual ao modal, que compara com o compromisso como
 * ele abre. Sem isso, editar só o título depois traria a caixa de volta,
 * marcada, oferecendo a mensagem que a recepção já recusou.
 *
 * Devolve `{ descartada }` só se havia algo na fila (o modal avisa que não
 * vai mais). Nunca lança.
 */
export async function descartarConfirmacaoPendente(args: {
  accountId: string
  eventId: string
  agora?: Date
}): Promise<ConfirmacaoNaTela> {
  const agora = args.agora ?? new Date()
  try {
    const desfecho: DesfechoDaConfirmacao = { status: 'descartada', motivo: 'a caixa foi desmarcada', at: agora.toISOString() }
    const res = await db.execute(sql`
      WITH antes AS (
        SELECT id, confirmation_due_at
          FROM calendar_events
         WHERE id = ${args.eventId}
           AND account_id = ${args.accountId}
           FOR UPDATE
      )
      UPDATE calendar_events AS u
         SET confirmation_known = jsonb_build_object(
               'startsAt', u.starts_at, 'calendarId', u.calendar_id, 'contactId', u.contact_id),
             confirmation_result = CASE
                 WHEN antes.confirmation_due_at IS NOT NULL THEN ${JSON.stringify(desfecho)}::jsonb
                 ELSE u.confirmation_result
               END,
             confirmation_due_at = NULL,
             confirmation_conversation_id = NULL
        FROM antes
       WHERE u.id = antes.id
      RETURNING (antes.confirmation_due_at IS NOT NULL) AS havia
    `)
    const havia = (res.rows[0] as { havia?: boolean } | undefined)?.havia === true
    return havia ? { descartada: true } : null
  } catch (err) {
    console.error('[agenda] confirmação: tirar da fila falhou:', err)
    return { naoEnviada: 'não foi possível cancelar a confirmação que estava na fila' }
  }
}

// ---------- O lado do worker ----------

type ItemDaFila = { id: string; accountId: string; lease: string; conversationId: string | null }

/**
 * Pega as vencidas com um LEASE atômico: o vencimento vira agora + 10 min
 * enquanto este tick envia. Outro worker (ou o próximo tick) pula as travadas
 * (SKIP LOCKED) e, se este morrer no meio, a linha volta sozinha quando o
 * lease vencer. O valor do lease volta em texto para o fim comparar com ele
 * exatamente (compare-and-swap), sem passar pelo Date do JS.
 */
export function sqlPegarVencidas(limite: number = LOTE_DA_FILA) {
  return sql`
    UPDATE calendar_events AS u
       SET confirmation_due_at = now() + interval '10 minutes'
     WHERE u.id IN (
             SELECT e.id
               FROM calendar_events AS e
              WHERE e.confirmation_due_at IS NOT NULL
                AND e.confirmation_due_at <= now()
              ORDER BY e.confirmation_due_at, e.id
              LIMIT ${limite}
                FOR UPDATE SKIP LOCKED
           )
    RETURNING u.id, u.account_id, u.confirmation_due_at::text AS lease,
              u.confirmation_conversation_id AS conversation_id
  `
}

/**
 * Fecha o item. `confirmation_known` e `confirmation_result` sempre (é o que
 * aconteceu); vencimento e conversa só se o vencimento AINDA é o do lease: se
 * a recepção salvou de novo enquanto o worker enviava, o pendente novo fica e
 * sai depois, com a versão nova. Num UPDATE todo SET lê a linha de ANTES, então
 * os dois CASE comparam o mesmo valor.
 */
export function sqlFecharItem(args: {
  id: string
  accountId: string
  lease: string
  desfecho: DesfechoDaConfirmacao
  novoConhecido: ConfirmacaoConhecida | null
}) {
  return sql`
    UPDATE calendar_events
       SET confirmation_known = COALESCE(${args.novoConhecido ? JSON.stringify(args.novoConhecido) : null}::jsonb, confirmation_known),
           confirmation_result = ${JSON.stringify(args.desfecho)}::jsonb,
           confirmation_conversation_id = CASE
               WHEN confirmation_due_at = ${args.lease}::timestamptz THEN NULL
               ELSE confirmation_conversation_id
             END,
           confirmation_due_at = CASE
               WHEN confirmation_due_at = ${args.lease}::timestamptz THEN NULL
               ELSE confirmation_due_at
             END
     WHERE id = ${args.id}
       AND account_id = ${args.accountId}
  `
}

async function fecharItem(args: Parameters<typeof sqlFecharItem>[0]): Promise<void> {
  try {
    await db.execute(sqlFecharItem(args))
  } catch (err) {
    // Uma segunda tentativa: se a confirmação SAIU e isto não gravar, o lease
    // vence em 10 min e o worker mandaria de novo.
    console.error('[booking-confirmation] fechar o item falhou, tentando de novo:', err)
    await db.execute(sqlFecharItem(args))
  }
}

/** Nota interna na conversa de WhatsApp do paciente. Best-effort. */
async function anotarNaConversa(args: {
  accountId: string
  contactId: string
  conversationId: string | null
  desfecho: DesfechoDaConfirmacao
  startsAt: string
  allDay: boolean
}): Promise<void> {
  try {
    const settings = await getAccountSettings(args.accountId)
    const texto = notaDaConfirmacaoQueNaoSaiu({
      desfecho: args.desfecho,
      startsAt: args.startsAt,
      allDay: args.allDay,
      tz: settings.businessTimezone || FUSO_PADRAO,
    })
    if (!texto) return
    const conversa = await conversaDoPaciente(args.accountId, args.contactId, args.conversationId)
    if (!conversa) return
    // Igual às outras notas de sistema (pausa da cobrança, limite da IA):
    // INSERT direto, 'bot' + is_internal. Não passa pelo envio, então não sai
    // para o paciente, não dispara a IA nem conta como resposta de atendente.
    await db.insert(messages).values({
      conversationId: conversa.id,
      senderType: 'bot',
      contentType: 'text',
      contentText: texto,
      isInternal: true,
      status: 'sent',
    })
  } catch (err) {
    console.error('[booking-confirmation] nota na conversa falhou:', err)
  }
}

/** Um item da fila: decide, envia (ou não), fecha e, se não saiu, anota. */
async function processarItem(item: ItemDaFila): Promise<DesfechoDaConfirmacao | null> {
  const ev = firstOrNull(
    await db
      .select({
        status: calendarEvents.status,
        startsAt: calendarEvents.startsAt,
        allDay: calendarEvents.allDay,
        calendarId: calendarEvents.calendarId,
        contactId: calendarEvents.contactId,
        calendarName: calendars.name,
        known: calendarEvents.confirmationKnown,
      })
      .from(calendarEvents)
      .leftJoin(calendars, and(eq(calendars.id, calendarEvents.calendarId), eq(calendars.accountId, item.accountId)))
      .where(and(eq(calendarEvents.id, item.id), eq(calendarEvents.accountId, item.accountId)))
      .limit(1),
  )
  // Apagado entre o lease e aqui: a linha sumiu, não há o que fechar.
  if (!ev) return null

  const conhecido = isConfirmacaoConhecida(ev.known) ? ev.known : null
  const decisao = decidirNaFila({
    final: { ...ev, nomeAgenda: ev.calendarName },
    conhecido: conhecido && {
      ...conhecido,
      nomeAgenda:
        conhecido.calendarId === ev.calendarId ? ev.calendarName : await nomeDaAgenda(item.accountId, conhecido.calendarId),
    },
  })

  let desfecho: DesfechoDaConfirmacao
  let novoConhecido: ConfirmacaoConhecida | null = null
  if (decisao.acao === 'descartar') {
    desfecho = { status: 'descartada', motivo: decisao.motivo, at: new Date().toISOString() }
  } else if (decisao.acao === 'semMudanca') {
    desfecho = { status: 'semMudanca', at: new Date().toISOString() }
  } else {
    const r = await enviarConfirmacaoDoAgendamento({
      accountId: item.accountId,
      eventId: item.id,
      tipo: decisao.tipo,
      conversationId: item.conversationId,
    })
    desfecho = desfechoDoEnvio(r, new Date())
    // Incerta também vira base: a mensagem pode ter chegado, e a próxima
    // mudança manda o horário inteiro de novo — o paciente nunca fica com
    // informação errada; tratar como "não sabe" arriscaria mandar duas vezes.
    if (desfecho.status === 'enviada' || desfecho.status === 'incerta') {
      novoConhecido = { startsAt: ev.startsAt, calendarId: ev.calendarId, contactId: ev.contactId }
    }
  }

  await fecharItem({ id: item.id, accountId: item.accountId, lease: item.lease, desfecho, novoConhecido })

  if (
    (desfecho.status === 'naoEnviada' || desfecho.status === 'incerta') &&
    ev.contactId &&
    desfecho.motivo !== MOTIVO_SUMIU
  ) {
    await anotarNaConversa({
      accountId: item.accountId,
      contactId: ev.contactId,
      conversationId: item.conversationId,
      desfecho,
      startsAt: ev.startsAt,
      allDay: ev.allDay,
    })
  }
  return desfecho
}

export type ResumoDaFila = { lidas: number; enviadas: number; naoEnviadas: number; erros: number }

/**
 * Um tick do worker: pega até LOTE_DA_FILA confirmações vencidas e resolve uma
 * por uma, em ordem (a cópia da mesma consulta em outra agenda só é julgada
 * depois de a primeira sair da fila — ver a regra da cópia no envio). Erro num
 * item não derruba os outros: ele fica com o lease e volta em 10 min.
 */
export async function processarConfirmacoesVencidas(): Promise<ResumoDaFila> {
  const resumo: ResumoDaFila = { lidas: 0, enviadas: 0, naoEnviadas: 0, erros: 0 }
  const res = await db.execute(sqlPegarVencidas())
  const itens: ItemDaFila[] = (
    res.rows as { id: string; account_id: string; lease: string; conversation_id: string | null }[]
  ).map((r) => ({ id: r.id, accountId: r.account_id, lease: r.lease, conversationId: r.conversation_id ?? null }))
  resumo.lidas = itens.length
  for (const item of itens) {
    try {
      const d = await processarItem(item)
      if (d?.status === 'enviada') resumo.enviadas++
      else if (d?.status === 'naoEnviada' || d?.status === 'incerta') resumo.naoEnviadas++
    } catch (err) {
      resumo.erros++
      console.error(`[booking-confirmation] compromisso ${item.id}: falhou, volta quando o lease vencer:`, err)
    }
  }
  return resumo
}
