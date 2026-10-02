// ============================================================
// Google Calendar — sync (import Google → CRM) + refresh de token.
// v1: importa eventos das agendas do Google conectadas. O outbound
// (CRM → Google) entra na etapa seguinte.
// ============================================================

import { and, eq, gte, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import { db, calendarConnections, calendars, calendarEvents, contacts } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { phoneFromDescription, phoneKey } from './event-contact'
import { descricaoParaGoogle, levarPacienteAoGoogle, type PacienteDoEvento } from './event-patient'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { zonedIso } from '@/lib/assistant/rules'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { mudouOInicio, recomecoDoLembrete } from '@/lib/ai/meeting-reminder-block'
import {
  refreshAccessToken,
  listGoogleEvents,
  getGoogleEvent,
  listCalendarList,
  insertGoogleEvent,
  patchGoogleEvent,
  deleteGoogleEvent,
  type GoogleEvent,
  type GoogleEventBody,
} from './calendar'

type ConnectionRow = {
  id: string
  accessToken: string
  refreshToken: string | null
  tokenExpiry: string | null
}

/** Access token válido; renova pelo refresh_token quando perto de expirar. */

/**
 * O contato dono do telefone escrito na descrição do evento — ou null.
 *
 * Compara pelos 8 últimos dígitos, que é o pedaço que sobrevive a "com 55",
 * "sem 55", "com o 9º dígito" e "sem". Devolve null quando não há telefone,
 * quando ninguém tem aquele número e — principalmente — quando DOIS contatos
 * têm: na dúvida o evento fica órfão, e alguém liga à mão.
 */
async function contatoPeloTelefone(
  accountId: string,
  description: string | null | undefined,
): Promise<string | null> {
  const fone = phoneFromDescription(description)
  const chave = phoneKey(fone)
  if (!chave) return null
  try {
    const achados = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.accountId, accountId),
          sql`right(regexp_replace(${contacts.phone}, '[^0-9]', '', 'g'), 8) = ${chave}`,
        ),
      )
      .limit(2)
    return achados.length === 1 ? achados[0].id : null
  } catch (err) {
    // Falha aqui não pode derrubar o sync da agenda: o evento entra órfão,
    // como entrava antes.
    console.error('[google-sync] contato pelo telefone falhou:', err)
    return null
  }
}

/**
 * now() do Postgres, em texto — o mesmo relógio que grava `updated_at` (os
 * salvares do CRM gravam now() do banco). O relógio do servidor da aplicação
 * pode estar uns segundos fora.
 */
async function agoraNoBanco(): Promise<string> {
  const res = await db.execute(sql`SELECT now()::text AS agora`)
  const agora = (res.rows[0] as { agora?: string } | undefined)?.agora
  if (!agora) throw new Error('o banco não devolveu a hora')
  return agora
}

export async function getValidAccessToken(conn: ConnectionRow): Promise<string> {
  const expiryMs = conn.tokenExpiry ? Date.parse(conn.tokenExpiry) : 0
  const stillValid = expiryMs - Date.now() > 60_000
  if (stillValid) return decrypt(conn.accessToken)

  if (!conn.refreshToken) return decrypt(conn.accessToken) // sem refresh: tenta o atual
  const refreshed = await refreshAccessToken(decrypt(conn.refreshToken))
  const newExpiry = new Date(Date.now() + (refreshed.expires_in ?? 3600) * 1000).toISOString()
  await db
    .update(calendarConnections)
    .set({ accessToken: encrypt(refreshed.access_token), tokenExpiry: newExpiry, updatedAt: sql`now()` })
    .where(eq(calendarConnections.id, conn.id))
  return refreshed.access_token
}

/** 'YYYY-MM-DD' − 1 dia (o fim de evento de dia inteiro no Google é EXCLUSIVO). */
function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Datas do Google → instantes nossos.
 *
 * O evento de DIA INTEIRO é uma data solta ("2026-09-15"), não um instante. A v1
 * fazia `new Date('2026-09-15T00:00:00')`, que o Node lê no fuso do servidor
 * (UTC no container) — em Brasília isso vira 14/09 21:00, e o compromisso
 * aparecia um dia antes (o "Equipotel" do Renato, 17/09). Agora a data é
 * ancorada no fuso da conta, na mesma convenção que a Agenda já usa pros
 * eventos criados aqui: 00:00 do primeiro dia → 23:59 do último dia coberto.
 */
function mapTimes(
  ev: Pick<GoogleEvent, 'start' | 'end'>,
  tz: string,
): { startsAt: string; endsAt: string; allDay: boolean } | null {
  if (ev.start?.date && ev.end?.date) {
    const lastDay = previousDay(ev.end.date)
    const endDay = lastDay < ev.start.date ? ev.start.date : lastDay
    return {
      startsAt: zonedIso(ev.start.date, '00:00', tz),
      endsAt: zonedIso(endDay, '23:59', tz),
      allDay: true,
    }
  }
  const s = ev.start?.dateTime ?? null
  const e = ev.end?.dateTime ?? null
  if (!s || !e) return null
  return { startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString(), allDay: false }
}

/** 'YYYY-MM-DD' de um instante, no fuso da conta (pro Google, que quer data). */
function dateInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}

/**
 * Espelha a lista de agendas do Google desta conexão em `calendars`.
 *
 * Idempotente: agenda já conhecida é reatada à conexão, agenda nova é criada.
 * Nunca apaga — agenda que sumiu do Google fica, com os eventos que já tinha, e
 * some sozinha do dia a dia quando não recebe mais nada.
 *
 * ⚠️ O Google só devolve aqui as agendas em que a conta conectada é `writer`.
 * Subagenda compartilhada como "somente leitura" não aparece, e o jeito de
 * resolver é do lado do Google: compartilhar com permissão de alterar eventos.
 *
 * Falha de rede aqui não pode derrubar a importação dos eventos: se a lista não
 * vier, seguimos com as agendas que já temos.
 */
export async function descobrirAgendas(
  accountId: string,
  connectionId: string,
  accessToken: string,
): Promise<void> {
  try {
    const list = await listCalendarList(accessToken)
    for (const gcal of list) {
      const already = firstOrNull(
        await db
          .select({ id: calendars.id })
          .from(calendars)
          .where(and(eq(calendars.accountId, accountId), eq(calendars.googleCalendarId, gcal.id)))
          .limit(1),
      )
      if (already) {
        // Só reata a conexão: NÃO mexe no nome nem na cor, que o dono pode ter
        // trocado aqui dentro para algo que faça sentido para a equipe dele.
        await db
          .update(calendars)
          .set({ connectionId, source: 'google', updatedAt: sql`now()` })
          .where(eq(calendars.id, already.id))
      } else {
        await db.insert(calendars).values({
          accountId,
          createdBy: null,
          name: gcal.summary || 'Google',
          color: gcal.backgroundColor || '#4285F4',
          source: 'google',
          googleCalendarId: gcal.id,
          connectionId,
        })
        console.log(`[google sync] agenda nova: ${gcal.summary || gcal.id}`)
      }
    }
  } catch (err) {
    console.error('[google sync] não consegui listar as agendas:', err)
  }
}

// ============================================================
// 👻 Fantasma do evento MOVIDO de agenda no Google (02/10/2026).
//
// Verificado em produção em 01/10, numa clínica com uma agenda do Google por
// profissional: a recepção cria o compromisso no CRM na agenda da dona (o
// modal abria com ela) e depois, no próprio Google Agenda, MOVE o evento para
// a agenda do profissional certo. O Google mantém o MESMO id. No CRM, o import
// da agenda nova cria a linha dela — e a linha da agenda antiga ficava
// 'confirmed' para sempre:
//  - ocupava um horário falso da dona (a IA via ocupado);
//  - travava a confirmação ao agendar ("paciente já tem outro compromisso
//    neste horário");
//  - se depois o evento era apagado na agenda nova, a cópia antiga mandava o
//    LEMBRETE de uma consulta que não existe.
//
// Por que o import não pegava: na agenda antiga, o evento movido vira uma
// lápide — GET dá 200 com status 'cancelled' e início em 31/12/1999 (data
// fictícia). A listagem é por janela (-7d…+60d) com showDeleted, e a lápide de
// 1999 nunca cai nela. E o import só mexe no que vem na listagem.
//
// A varredura, por agenda, DEPOIS da listagem: linha confirmada desta agenda,
// com id do Google, início dentro da janela, que NÃO veio na listagem (nem
// como cancelada) e que ninguém criou nem mexeu nos últimos 10 min. Para cada
// uma, pergunta ao Google pelo id NAQUELA agenda; só cancela se ele responder
// que não existe (404/410) ou que está cancelado. "Não consegui perguntar"
// pula a linha.
//
// Por que isto não cancela compromisso de verdade:
//  - evento que existe nesta agenda com início na janela VEM na listagem
//    completa, então nem vira candidato; listagem cortada no teto de páginas
//    desliga a varredura daquela agenda;
//  - o evento que mudou de data para FORA da janela responde 200 confirmado
//    e a linha NÃO é cancelada — vai para a data nova (ver remarcarSumido);
//  - a linha recém-criada pelo push (o Google pode ainda não listar) ou
//    recém-editada pela recepção tem menos de 10 min e fica de fora — e o
//    UPDATE confere de novo, no relógio do banco;
//  - se mesmo assim o Google errar, a linha só muda de status, nada é
//    apagado: na primeira listagem que trouxer o evento, o import a devolve
//    para 'confirmed' (ele grava `status: 'confirmed'` em todo evento listado).
//
// ⚠️ Limite conhecido: evento movido para uma agenda que o CRM NÃO vê (o
// Google só nos lista as agendas em que a conta pode alterar eventos). Não há
// gêmeo, então o compromisso some do CRM e o paciente deixa de receber o
// lembrete que a fantasma mandava "por acaso". É coerente com o resto — nada
// do que está nessa agenda é lembrado —, e o log avisa para onde ele foi.
// ============================================================

/**
 * Linha criada (ou mexida) há menos que isto não é suspeita: o evento que o
 * push acabou de criar pode ainda não aparecer na listagem do Google.
 */
const SUMIDO_IDADE_MIN_MS = 10 * 60_000
/** Teto de perguntas ao Google por agenda por rodada. O resto fica para a próxima (5 min). */
export const SUMIDOS_POR_AGENDA = 50

export type LinhaSuspeita = {
  id: string
  googleEventId: string
  startsAt: string
  createdAt: string
  updatedAt: string
  contactId: string | null
  dealId: string | null
  remindersSent: number
}

/**
 * Quais linhas confirmadas desta agenda (já filtradas pela janela no banco)
 * merecem a pergunta ao Google. Puro, para dar para testar.
 *
 * Fora: o id que veio na listagem (inclusive cancelado — esse o import já
 * tratou) e a linha criada OU alterada há menos de 10 min. Data que não dá
 * para ler conta como recente: na dúvida, não mexe.
 *
 * Ordem: o que ainda vai acontecer primeiro (do mais próximo ao mais longe),
 * depois o que já passou. É no futuro que o fantasma faz estrago — lembrete e
 * horário que a IA deixa de oferecer. Acima de `limite`, o resto espera a
 * próxima rodada (`sobraram` vai para o log).
 */
export function quaisCandidatas(
  linhas: LinhaSuspeita[],
  idsNaListagem: ReadonlySet<string>,
  agoraMs: number,
  limite: number = SUMIDOS_POR_AGENDA,
): { candidatas: LinhaSuspeita[]; sobraram: number } {
  const velha = (quando: string) => {
    const t = Date.parse(quando)
    return Number.isFinite(t) && agoraMs - t >= SUMIDO_IDADE_MIN_MS
  }
  const todas = linhas.filter(
    (l) =>
      Boolean(l.googleEventId) &&
      !idsNaListagem.has(l.googleEventId) &&
      velha(l.createdAt) &&
      velha(l.updatedAt),
  )
  const inicio = (l: LinhaSuspeita) => {
    const t = Date.parse(l.startsAt)
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER
  }
  todas.sort((a, b) => {
    const ta = inicio(a)
    const tb = inicio(b)
    const futuraA = ta >= agoraMs
    const futuraB = tb >= agoraMs
    if (futuraA !== futuraB) return futuraA ? -1 : 1
    return ta - tb
  })
  return { candidatas: todas.slice(0, limite), sobraram: Math.max(0, todas.length - limite) }
}

/**
 * O que o Google respondeu sobre o evento NESTA agenda → cancela ou mantém.
 * Só 'gone' (404/410) e 'cancelled' (a lápide do evento movido) cancelam.
 * 200 confirmado ou tentativo mantém: é o evento que mudou de data para fora
 * da janela, não fantasma — e a linha vai para a data nova (remarcarSumido).
 */
export function decidirFantasma(noGoogle: { status?: string }): 'cancelar' | 'manter' {
  return noGoogle.status === 'gone' || noGoogle.status === 'cancelled' ? 'cancelar' : 'manter'
}

/**
 * As travas de toda escrita da varredura numa linha suspeita, repetidas no
 * relógio do BANCO: a linha certa, desta conta e agenda, com o mesmo id do
 * Google, ainda confirmada e que ninguém criou nem mexeu nos últimos 10 min.
 * Se a recepção acabou de editar o compromisso, ou outra sincronização já o
 * cancelou, a escrita não pega nada. Cancelar e remarcar usam as MESMAS.
 */
function travasDaSuspeita(accountId: string, calendarId: string, linha: LinhaSuspeita): SQL | undefined {
  const idadeMin = sql.raw(`interval '${Math.round(SUMIDO_IDADE_MIN_MS / 1000)} seconds'`)
  return and(
    eq(calendarEvents.id, linha.id),
    eq(calendarEvents.accountId, accountId),
    eq(calendarEvents.calendarId, calendarId),
    eq(calendarEvents.googleEventId, linha.googleEventId),
    eq(calendarEvents.status, 'confirmed'),
    sql`${calendarEvents.createdAt} < now() - ${idadeMin}`,
    sql`${calendarEvents.updatedAt} < now() - ${idadeMin}`,
  )
}

/**
 * Cancela a linha fantasma e passa aos "gêmeos" o que não pode se perder.
 *
 * Gêmeo = linha 'confirmed' da MESMA conta, em OUTRA agenda, com o MESMO id do
 * Google: para onde o evento foi movido (o import da agenda nova a criou), ou
 * a cópia de uma agenda convidada. Id igual no Google é o mesmo evento, então
 * o que a fantasma sabia vale para ele:
 *  - lembrete: no gêmeo do MESMO instante, reminders_sent vira o maior dos
 *    dois — o lembrete que a fantasma já mandou não sai de novo pelo gêmeo.
 *    Só no gêmeo sem paciente ou com o MESMO paciente: o degrau gasto foi
 *    desse paciente, não de outro;
 *  - paciente e negócio: o gêmeo nasce do import, muitas vezes sem paciente
 *    (sem telefone na descrição), enquanto a fantasma foi ligada à mão ou pela
 *    IA. Só preenche o que está VAZIO no gêmeo.
 * Nessa ordem: o degrau é carimbado ANTES de o paciente chegar, senão o
 * lembrete poderia ver o gêmeo com paciente e contador zerado.
 *
 * Tudo numa transação: se a passagem falhar, a fantasma continua 'confirmed' e
 * a próxima rodada tenta de novo — em vez de cancelar e perder o paciente.
 *
 * O UPDATE repete as condições de candidata no relógio do banco (agenda, id
 * do Google, confirmado, intocado há 10 min): se a recepção acabou de editar
 * esse compromisso, ou outra sincronização já o cancelou, não faz nada.
 * `null` = não cancelou; senão, quantos gêmeos havia (0 = o evento foi para
 * uma agenda que o CRM não vê, ou foi apagado de vez).
 */
async function cancelarFantasma(
  accountId: string,
  calendarId: string,
  linha: LinhaSuspeita,
): Promise<{ gemeos: number } | null> {
  return db.transaction(async (tx) => {
    const res = await tx
      .update(calendarEvents)
      .set({ status: 'cancelled', updatedAt: sql`now()` })
      .where(travasDaSuspeita(accountId, calendarId, linha))
      // O que passa ao gêmeo sai DAQUI, da linha no instante em que foi
      // cancelada (02/10, revisão) — não da leitura da varredura, feita ANTES
      // das perguntas ao Google: nesse meio-tempo o lembrete pode ter saído
      // (reminders_sent andou) ou a recepção pode ter ligado o paciente.
      .returning({
        id: calendarEvents.id,
        contactId: calendarEvents.contactId,
        dealId: calendarEvents.dealId,
        remindersSent: calendarEvents.remindersSent,
        startsAt: calendarEvents.startsAt,
      })
    const fantasma = res[0]
    if (!fantasma) return null

    const gemeos = and(
      eq(calendarEvents.accountId, accountId),
      eq(calendarEvents.googleEventId, linha.googleEventId),
      ne(calendarEvents.calendarId, calendarId),
      eq(calendarEvents.status, 'confirmed'),
    )
    const achados = await tx.select({ id: calendarEvents.id }).from(calendarEvents).where(gemeos)
    if (!achados.length) return { gemeos: 0 }

    if (fantasma.contactId && fantasma.remindersSent > 0) {
      await tx
        .update(calendarEvents)
        .set({ remindersSent: sql`GREATEST(${calendarEvents.remindersSent}, ${fantasma.remindersSent})` })
        .where(
          and(
            gemeos,
            eq(calendarEvents.startsAt, fantasma.startsAt),
            lt(calendarEvents.remindersSent, fantasma.remindersSent),
            or(isNull(calendarEvents.contactId), eq(calendarEvents.contactId, fantasma.contactId)),
          ),
        )
    }
    if (fantasma.contactId) {
      await tx
        .update(calendarEvents)
        .set({ contactId: fantasma.contactId })
        .where(and(gemeos, isNull(calendarEvents.contactId)))
    }
    if (fantasma.dealId) {
      await tx
        .update(calendarEvents)
        .set({ dealId: fantasma.dealId })
        .where(and(gemeos, isNull(calendarEvents.dealId)))
    }
    return { gemeos: achados.length }
  })
}

/**
 * 📅 O evento sumido da listagem que o Google diz que existe (200 confirmado)
 * com OUTRA data — remarcado no Google para fora da janela (02/10/2026).
 *
 * Antes a linha ficava como estava, com a data VELHA: o paciente recebia o
 * lembrete do dia errado (a consulta que foi para daqui a três meses avisava
 * "é amanhã") e o GET se repetia a cada rodada, porque a linha velha seguia
 * caindo na janela. Agora ela vai para a data do Google — início, fim e dia
 * inteiro — com o recomeço do lembrete de qualquer remarcação
 * (recomecoDoLembrete: zera, ou restaura se voltou ao horário de antes). Na
 * data nova fora da janela, a linha sai da varredura sozinha.
 *
 * As MESMAS travas do cancelamento (travasDaSuspeita), no relógio do banco.
 * Numa transação, com a linha travada: o contador que decide entre zerar e
 * restaurar é lido AGORA, não na leitura da varredura feita antes das
 * perguntas ao Google — nesse meio-tempo o lembrete da data velha pode ter
 * saído. `false` = não mexeu (alguém mexeu na linha há pouco, ou ela já não
 * está de pé).
 */
async function remarcarSumido(
  accountId: string,
  calendarId: string,
  linha: LinhaSuspeita,
  datas: { startsAt: string; endsAt: string; allDay: boolean },
): Promise<boolean> {
  const travas = travasDaSuspeita(accountId, calendarId, linha)
  return db.transaction(async (tx) => {
    const atual = firstOrNull(
      await tx
        .select({
          startsAt: calendarEvents.startsAt,
          remindersSent: calendarEvents.remindersSent,
          remindersPrevStartsAt: calendarEvents.remindersPrevStartsAt,
          remindersPrevSent: calendarEvents.remindersPrevSent,
        })
        .from(calendarEvents)
        .where(travas)
        .for('update')
        .limit(1),
    )
    if (!atual || !mudouOInicio(atual.startsAt, datas.startsAt)) return false
    const res = await tx
      .update(calendarEvents)
      .set({
        startsAt: datas.startsAt,
        endsAt: datas.endsAt,
        allDay: datas.allDay,
        ...recomecoDoLembrete(atual, datas.startsAt),
        updatedAt: sql`now()`,
      })
      .where(travas)
      .returning({ id: calendarEvents.id })
    return res.length > 0
  })
}

/**
 * A varredura de UMA agenda, depois da listagem completa dela. Devolve quantas
 * linhas cancelou (a remarcada para fora da janela não conta: ela segue de
 * pé). Nunca lança: é faxina — falhar aqui não pode gravar last_sync_error
 * ("reconecte o Google") nem parar a importação das outras agendas.
 */
async function liberarSumidos(p: {
  accountId: string
  calendarId: string
  calGoogleId: string
  accessToken: string
  idsNaListagem: ReadonlySet<string>
  timeMin: string
  timeMax: string
  /** Fuso da conta: ancora a data nova do evento de dia inteiro (mapTimes). */
  tz: string
}): Promise<number> {
  let linhas: LinhaSuspeita[]
  try {
    const brutas = await db
      .select({
        id: calendarEvents.id,
        googleEventId: calendarEvents.googleEventId,
        startsAt: calendarEvents.startsAt,
        createdAt: calendarEvents.createdAt,
        updatedAt: calendarEvents.updatedAt,
        contactId: calendarEvents.contactId,
        dealId: calendarEvents.dealId,
        remindersSent: calendarEvents.remindersSent,
      })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.accountId, p.accountId),
          eq(calendarEvents.calendarId, p.calendarId),
          eq(calendarEvents.status, 'confirmed'),
          isNotNull(calendarEvents.googleEventId),
          // A MESMA janela da listagem. O Google devolve o evento que termina
          // depois de timeMin e começa antes de timeMax: quem COMEÇA aqui
          // dentro e existe nesta agenda teria vindo.
          gte(calendarEvents.startsAt, p.timeMin),
          lt(calendarEvents.startsAt, p.timeMax),
        ),
      )
    linhas = brutas.flatMap((l) => (l.googleEventId ? [{ ...l, googleEventId: l.googleEventId }] : []))
  } catch (err) {
    console.error(
      `[google sync] ${p.calGoogleId}: varredura de sumidos não leu o banco:`,
      err instanceof Error ? err.message : err,
    )
    return 0
  }

  const { candidatas, sobraram } = quaisCandidatas(linhas, p.idsNaListagem, Date.now())
  if (sobraram) {
    console.warn(`[google sync] ${p.calGoogleId}: ${sobraram} suspeita(s) de evento sumido ficam para a próxima rodada`)
  }

  let liberados = 0
  for (const linha of candidatas) {
    // As datas entram para a remarcação (02/10); o organizador, para o log.
    let noGoogle: Pick<GoogleEvent, 'status' | 'organizer' | 'start' | 'end'>
    try {
      noGoogle = await getGoogleEvent(p.accessToken, p.calGoogleId, linha.googleEventId)
    } catch (err) {
      // Não deu para perguntar ≠ não existe. Fica como está; próxima rodada.
      console.error(
        `[google sync] ${p.calGoogleId}: não consegui conferir o evento ${linha.googleEventId} (fica como está):`,
        err instanceof Error ? err.message : err,
      )
      continue
    }
    if (decidirFantasma(noGoogle) === 'manter') {
      // 📅 Existe nesta agenda, mas não veio na listagem: mudou de data no
      // Google para fora da janela (02/10). A linha vai para a data nova — ver
      // remarcarSumido. Mesma data (ou sem data legível) = não mexe.
      const datas = mapTimes(noGoogle, p.tz)
      if (!datas || !mudouOInicio(linha.startsAt, datas.startsAt)) continue
      try {
        if (await remarcarSumido(p.accountId, p.calendarId, linha, datas)) {
          console.log(
            `[google sync] ${p.calGoogleId}: compromisso ${linha.id} foi para ${datas.startsAt} — o evento ${linha.googleEventId} mudou de data no Google (fora da janela da listagem)`,
          )
        }
      } catch (err) {
        console.error(
          `[google sync] ${p.calGoogleId}: não consegui levar o compromisso ${linha.id} para a data nova do Google:`,
          err instanceof Error ? err.message : err,
        )
      }
      continue
    }
    try {
      const feito = await cancelarFantasma(p.accountId, p.calendarId, linha)
      if (!feito) continue
      liberados += 1
      // Na lápide do evento movido, o organizador é a agenda para onde ele foi.
      const destino = noGoogle.organizer?.email
      const movido = destino && destino !== p.calGoogleId ? `, movido para ${destino}` : ''
      console.log(
        `[google sync] ${p.calGoogleId}: compromisso ${linha.id} liberado — o evento ${linha.googleEventId} não está mais nesta agenda (${noGoogle.status}${movido}); ${feito.gemeos} gêmeo(s) em outra agenda`,
      )
      if (!feito.gemeos && movido) {
        // Movido, mas sem cópia em nenhuma outra agenda do CRM. Quase sempre é
        // agenda que o CRM não enxerga (o Google só nos mostra as agendas em
        // que a conta conectada pode ALTERAR eventos): o compromisso some
        // daqui e, com ele, o lembrete do paciente. Quem resolve é a clínica,
        // compartilhando essa agenda com permissão de alterar eventos. (Também
        // acontece se a data nova caiu fora da janela de -7d…+60d.)
        console.warn(
          `[google sync] ${p.calGoogleId}: o evento ${linha.googleEventId} foi para ${destino} e não tem cópia em outra agenda do CRM — se essa agenda não aparece no CRM, compartilhe-a com permissão de alterar eventos`,
        )
      }
    } catch (err) {
      console.error(
        `[google sync] ${p.calGoogleId}: não consegui liberar o compromisso ${linha.id}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  return liberados
}

/** Importa eventos (janela -7d…+60d) de todas as agendas Google desta conexão. */
export async function importGoogleEvents(
  accountId: string,
  connectionId: string,
): Promise<{ imported: number; cancelled: number }> {
  const conn = firstOrNull(
    await db
      .select({
        id: calendarConnections.id,
        accessToken: calendarConnections.accessToken,
        refreshToken: calendarConnections.refreshToken,
        tokenExpiry: calendarConnections.tokenExpiry,
      })
      .from(calendarConnections)
      .where(and(eq(calendarConnections.id, connectionId), eq(calendarConnections.accountId, accountId)))
      .limit(1),
  )
  if (!conn) return { imported: 0, cancelled: 0 }

  try {
    const accessToken = await getValidAccessToken(conn)
    // Fuso da conta: é o que ancora as datas dos eventos de dia inteiro.
    const tz = (await getAccountSettings(accountId)).businessTimezone || 'America/Sao_Paulo'

    // Agendas NOVAS do Google entram aqui, a cada sincronização.
    //
    // 30/09 (clínica da Dra. Joyce): as atendentes não conseguiam escolher a
    // subagenda do profissional — porque no CRM ela não existia. A lista de
    // agendas do Google só era lida no momento de conectar a conta, no callback
    // do OAuth; qualquer agenda criada ou compartilhada DEPOIS ficava invisível
    // para sempre, e a única saída teria sido desconectar e reconectar o Google.
    // A clínica tinha uma agenda só no CRM enquanto usava várias no Google.
    await descobrirAgendas(accountId, connectionId, accessToken)

    const cals = await db
      .select({ id: calendars.id, googleCalendarId: calendars.googleCalendarId })
      .from(calendars)
      .where(and(eq(calendars.accountId, accountId), eq(calendars.connectionId, connectionId)))

    const timeMin = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const timeMax = new Date(Date.now() + 60 * 86_400_000).toISOString()

    let imported = 0
    let cancelled = 0
    const aVarrer: { calendarId: string; calGoogleId: string; idsNaListagem: Set<string> }[] = []
    for (const cal of cals) {
      if (!cal.googleCalendarId) continue
      // O relógio do BANCO antes de pedir a lista ao Google (02/10, revisão).
      // A listagem é uma foto desse instante; o que a recepção salvou no CRM
      // DEPOIS dela (entre a resposta do Google e o UPDATE abaixo, que pode
      // demorar numa agenda grande) não pode ser desfeito pela foto velha —
      // a linha fica para a próxima rodada, que já lista com o push dela.
      const inicioDaListagem = await agoraNoBanco()
      // showDeleted: o apagado precisa CHEGAR aqui pra liberar o horário.
      const listagem = { truncated: false }
      const events = await listGoogleEvents(accessToken, cal.googleCalendarId, timeMin, timeMax, {
        showDeleted: true,
        resultado: listagem,
      })
      // Tudo o que o Google listou nesta agenda, inclusive cancelado e o que o
      // mapTimes descarta — é o "existe aqui" da varredura de sumidos abaixo.
      const idsNaListagem = new Set<string>()
      for (const ev of events) {
        idsNaListagem.add(ev.id)
        // Apagado no Google. Vem antes de mapTimes de propósito: evento apagado
        // costuma voltar só com o id, sem start/end — se caísse no mapTimes,
        // seria descartado e a cópia daqui seguiria ocupando o horário.
        if (ev.status === 'cancelled') {
          const res = await db
            .update(calendarEvents)
            .set({ status: 'cancelled', updatedAt: sql`now()` })
            .where(
              and(
                eq(calendarEvents.calendarId, cal.id),
                eq(calendarEvents.googleEventId, ev.id),
                eq(calendarEvents.status, 'confirmed'),
              ),
            )
            .returning({ id: calendarEvents.id })
          cancelled += res.length
          continue
        }
        const times = mapTimes(ev, tz)
        if (!times) continue
        const existing = firstOrNull(
          await db
            .select({
              id: calendarEvents.id,
              startsAt: calendarEvents.startsAt,
              // O recomeço do lembrete decide entre zerar e restaurar (0206).
              remindersSent: calendarEvents.remindersSent,
              remindersPrevStartsAt: calendarEvents.remindersPrevStartsAt,
              remindersPrevSent: calendarEvents.remindersPrevSent,
            })
            .from(calendarEvents)
            .where(and(eq(calendarEvents.calendarId, cal.id), eq(calendarEvents.googleEventId, ev.id)))
            .limit(1),
        )
        // 📞 Liga ao paciente pelo telefone da descrição (ver event-contact.ts).
        // Só quando há UM contato com aquele número: dois candidatos viram
        // evento órfão, porque lembrete no paciente errado é pior que nenhum.
        const contactId = await contatoPeloTelefone(accountId, ev.description)

        const values = {
          title: ev.summary?.trim() || '(sem título)',
          description: ev.description ?? null,
          // O link do Meet mora no hangoutLink, não no location: sem isso o import
          // apagava a sala que o CRM tinha guardado (e com ela o sinal de que é
          // reunião com convidados — event-patient.ts não enriquece essas).
          location: ev.location ?? ev.hangoutLink ?? null,
          startsAt: times.startsAt,
          endsAt: times.endsAt,
          allDay: times.allDay,
          status: 'confirmed',
          // "Mostrar como: Disponível" no Google não ocupa o horário (0183).
          busy: ev.transparency !== 'transparent',
        }
        if (existing) {
          // ⚠️ `contactId` NÃO entra no update do evento que já existe: alguém
          // pode ter ligado o paciente à mão, e o sync (de 5 em 5 min) apagaria
          // esse trabalho toda vez. Só preenche o que está vazio.
          //
          // 01/10: arrastou no Google para outro horário = lembrete recomeça,
          // como na Agenda e na IA (ver recomecoDoLembrete). Antes o contador
          // da data antiga seguia valendo e a data nova ficava sem aviso.
          // 02/10: arrastou e arrastou DE VOLTA = o contador daquele horário
          // volta (não manda de novo o lembrete que já saiu).
          //
          // 02/10, revisão: só a linha que ninguém mexeu desde a listagem. Era
          // um UPDATE incondicional: a recepção salvava 10h→11h no CRM enquanto
          // a importação processava, e a foto do Google (ainda 10h) desfazia o
          // salvar. Pulada, a linha volta na próxima rodada; e como o UPDATE
          // não acontece, o recomeço do lembrete calculado com o horário lido
          // aqui também não.
          await db
            .update(calendarEvents)
            .set({
              ...values,
              ...recomecoDoLembrete(existing, values.startsAt),
              updatedAt: sql`now()`,
            })
            .where(and(eq(calendarEvents.id, existing.id), lt(calendarEvents.updatedAt, inicioDaListagem)))
          if (contactId) {
            await db
              .update(calendarEvents)
              .set({ contactId })
              .where(and(eq(calendarEvents.id, existing.id), isNull(calendarEvents.contactId)))
          }
        } else {
          await db.insert(calendarEvents).values({
            accountId,
            calendarId: cal.id,
            title: values.title,
            description: values.description,
            location: values.location,
            startsAt: values.startsAt,
            endsAt: values.endsAt,
            allDay: values.allDay,
            status: values.status,
            busy: values.busy,
            source: 'google',
            googleEventId: ev.id,
            contactId,
          })
          imported += 1
        }
      }

      // 👻 Evento movido para outra agenda (ou apagado) que a listagem não
      // mostra — ver liberarSumidos. Só com a lista INTEIRA: com ela cortada
      // no teto de páginas, "não veio" não quer dizer "não existe".
      if (listagem.truncated) {
        console.warn(`[google sync] ${cal.googleCalendarId}: listagem incompleta, sem varredura de sumidos nesta rodada`)
      } else {
        aVarrer.push({ calendarId: cal.id, calGoogleId: cal.googleCalendarId, idsNaListagem })
      }
    }

    // A varredura vem DEPOIS de importar TODAS as agendas, não agenda por
    // agenda: o evento movido da agenda A para a B nos últimos minutos ainda
    // não tem linha na B quando a A é processada (a ordem das agendas é a do
    // banco). Varrendo a A primeiro, a fantasma seria cancelada sem gêmeo, e o
    // paciente ligado nela não passaria para a linha que o import da B cria
    // logo depois.
    for (const v of aVarrer) {
      cancelled += await liberarSumidos({ accountId, accessToken, timeMin, timeMax, tz, ...v })
    }
    await db
      .update(calendarConnections)
      .set({ lastSyncedAt: sql`now()`, lastSyncError: null, updatedAt: sql`now()` })
      .where(eq(calendarConnections.id, connectionId))
    return { imported, cancelled }
  } catch (err) {
    // Grava o motivo em vez de sumir com ele: token revogado tem que aparecer
    // na tela como "reconecte", não virar agenda vazia (= IA oferecendo tudo).
    const msg = err instanceof Error ? err.message : String(err)
    await db
      .update(calendarConnections)
      .set({ lastSyncError: msg.slice(0, 500), updatedAt: sql`now()` })
      .where(eq(calendarConnections.id, connectionId))
      .catch(() => {})
    throw err
  }
}

// ============================================================
// Sincronização automática. Até 17/09 a importação só rodava no clique
// ("Sincronizar" na Agenda) ou no instante da conexão — com a IA marcando
// reunião sozinha, isso significa oferecer horário em cima de uma foto velha
// da agenda do dono.
// ============================================================

/** Quanto tempo uma sincronização continua "fresca" para o caminho da IA. */
export const SYNC_FRESH_MS = 90_000

type ConnRef = { id: string; accountId: string }

async function connectionsOf(accountId?: string): Promise<ConnRef[]> {
  const base = db
    .select({ id: calendarConnections.id, accountId: calendarConnections.accountId })
    .from(calendarConnections)
  return accountId ? base.where(eq(calendarConnections.accountId, accountId)) : base
}

/**
 * Sincroniza as conexões de UMA conta. Usada antes de a IA oferecer horário.
 * Nunca lança e nunca demora: respeita a carência de `maxAgeMs` (não martela o
 * Google a cada mensagem) e desiste em `timeoutMs` — agenda um pouco velha é
 * ruim, resposta travada é pior.
 */
export async function syncAccountCalendars(
  accountId: string,
  opts: { maxAgeMs?: number; timeoutMs?: number } = {},
): Promise<{ synced: number }> {
  const maxAgeMs = opts.maxAgeMs ?? SYNC_FRESH_MS
  const timeoutMs = opts.timeoutMs ?? 4_000
  try {
    const stale = await db
      .select({ id: calendarConnections.id })
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.accountId, accountId),
          sql`(${calendarConnections.lastSyncedAt} IS NULL OR ${calendarConnections.lastSyncedAt} < now() - ${sql.raw(`interval '${Math.round(maxAgeMs / 1000)} seconds'`)})`,
        ),
      )
    if (!stale.length) return { synced: 0 }

    const work = Promise.all(
      stale.map((c) => importGoogleEvents(accountId, c.id).catch(() => null)),
    )
    const done = await Promise.race([
      work.then((rs) => rs.filter(Boolean).length),
      new Promise<number>((resolve) => setTimeout(() => resolve(0), timeoutMs)),
    ])
    return { synced: done }
  } catch (err) {
    console.error('[google sync] conta', accountId, err instanceof Error ? err.message : err)
    return { synced: 0 }
  }
}

/** Varre TODAS as contas — é o que o worker periódico chama. */
export async function syncAllGoogleConnections(): Promise<{ ok: number; failed: number }> {
  let ok = 0
  let failed = 0
  const conns = await connectionsOf()
  for (const c of conns) {
    try {
      const r = await importGoogleEvents(c.accountId, c.id)
      ok += 1
      if (r.imported || r.cancelled) {
        console.log(`[google sync] ${c.accountId}: +${r.imported} novo(s), ${r.cancelled} liberado(s)`)
      }
    } catch (err) {
      // Uma conexão podre (token revogado) não pode derrubar a varredura das
      // outras contas. O motivo já foi gravado em last_sync_error.
      failed += 1
      console.error(`[google sync] ${c.accountId} falhou:`, err instanceof Error ? err.message : err)
    }
  }
  return { ok, failed }
}

// ============================================================
// CRM → Google (mão dupla). Ao criar/editar/apagar um evento numa
// agenda do Google, espelha a operação no Google Calendar.
// Best-effort: falha aqui não derruba a operação no CRM.
// ============================================================

type PushRow = {
  id: string
  title: string
  description: string | null
  location: string | null
  startsAt: string
  endsAt: string
  allDay: boolean
  googleEventId: string | null
  calGoogleId: string | null
  connectionId: string | null
}

function toGoogleBody(row: PushRow, tz: string): GoogleEventBody {
  const body: GoogleEventBody = {
    summary: row.title,
    description: row.description ?? undefined,
    location: row.location ?? undefined,
    start: {},
    end: {},
  }
  if (row.allDay) {
    // Google usa datas (YYYY-MM-DD) e o fim é EXCLUSIVO. As datas saem do fuso
    // da conta, não de `slice(0,10)` do ISO: fatiar o UTC só acerta por acidente
    // em fuso negativo e erra o dia em qualquer fuso a leste de Greenwich.
    const startDate = dateInTz(row.startsAt, tz)
    const lastDay = dateInTz(row.endsAt, tz)
    const exclusive = new Date(`${(lastDay < startDate ? startDate : lastDay)}T00:00:00Z`)
    exclusive.setUTCDate(exclusive.getUTCDate() + 1)
    body.start.date = startDate
    body.end.date = exclusive.toISOString().slice(0, 10)
  } else {
    // O Postgres devolve timestamptz como "2026-08-13 15:00:00+00" (com espaço,
    // sem T/Z) — o Google exige RFC3339. new Date().toISOString() normaliza.
    body.start.dateTime = new Date(row.startsAt).toISOString()
    body.end.dateTime = new Date(row.endsAt).toISOString()
  }
  return body
}

/**
 * Nome e telefone do paciente ligado ao compromisso (escopo da conta). Null =
 * sem paciente. LANÇA se o banco falhar: quem chama manda o evento como antes,
 * em vez de tratar a falha como "paciente desligado" e apagar o bloco no Google.
 */
async function pacienteDoEvento(accountId: string, contactId: string | null): Promise<PacienteDoEvento | null> {
  if (!contactId) return null
  const c = firstOrNull(
    await db
      .select({ name: contacts.name, phone: contacts.phone, isGroup: contacts.isGroup })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
      .limit(1),
  )
  // Grupo do WhatsApp não é paciente: o `phone` dele é o id do grupo e o nome
  // é o do grupo. Nenhum bloco.
  if (!c || c.isGroup) return null
  return { name: c.name, phone: c.phone }
}

/** Token da conexão do Google — só se a conexão for desta conta. null = não há. */
async function tokenDaConexao(accountId: string, connectionId: string): Promise<string | null> {
  const conn = firstOrNull(
    await db
      .select({
        id: calendarConnections.id,
        accessToken: calendarConnections.accessToken,
        refreshToken: calendarConnections.refreshToken,
        tokenExpiry: calendarConnections.tokenExpiry,
      })
      .from(calendarConnections)
      .where(and(eq(calendarConnections.id, connectionId), eq(calendarConnections.accountId, accountId)))
      .limit(1),
  )
  return conn ? getValidAccessToken(conn) : null
}

/**
 * Apaga no Google um evento que a linha do CRM JÁ NÃO aponta — o que ficou na
 * agenda antiga quando o compromisso trocou de agenda (ver event-move.ts).
 * No-op se aquela agenda não for do Google desta conta. 404/410 = já não existe.
 */
export async function apagarEventoNoGoogle(
  accountId: string,
  calendarId: string,
  googleEventId: string,
): Promise<void> {
  const cal = firstOrNull(
    await db
      .select({ calGoogleId: calendars.googleCalendarId, connectionId: calendars.connectionId })
      .from(calendars)
      .where(and(eq(calendars.id, calendarId), eq(calendars.accountId, accountId)))
      .limit(1),
  )
  if (!cal?.calGoogleId || !cal.connectionId) return
  const accessToken = await tokenDaConexao(accountId, cal.connectionId)
  if (!accessToken) return
  await deleteGoogleEvent(accessToken, cal.calGoogleId, googleEventId)
}

/** Espelha um evento do CRM no Google. op: 'create' | 'update' | 'delete'.
 *  No-op se a agenda do evento não for do Google. */
export async function pushEventToGoogle(
  accountId: string,
  eventId: string,
  op: 'create' | 'update' | 'delete',
  /**
   * Só na criação: sala do Google Meet + convidados (o Google manda o convite
   * por e-mail). Renato/Zelo 18/09: "teria que ir pro calendário, marcar a
   * reunião, convidar ela e eu e agendar o Google Meet".
   */
  opts: { meet?: boolean; attendees?: string[] } = {},
): Promise<{ hangoutLink?: string } | void> {
  const row = firstOrNull(
    await db
      .select({
        id: calendarEvents.id,
        title: calendarEvents.title,
        description: calendarEvents.description,
        location: calendarEvents.location,
        startsAt: calendarEvents.startsAt,
        endsAt: calendarEvents.endsAt,
        allDay: calendarEvents.allDay,
        googleEventId: calendarEvents.googleEventId,
        contactId: calendarEvents.contactId,
        calGoogleId: calendars.googleCalendarId,
        connectionId: calendars.connectionId,
      })
      .from(calendarEvents)
      // A agenda e a conexão também têm que ser DESTA conta (01/10): o evento
      // agora leva telefone, e escrever com o token de outra conta faria o
      // import DELA ligar o evento a um contato dela e disparar lembrete.
      .innerJoin(calendars, and(eq(calendarEvents.calendarId, calendars.id), eq(calendars.accountId, accountId)))
      .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.accountId, accountId)))
      .limit(1),
  )
  // Agenda local (não-Google) → nada a espelhar.
  if (!row || !row.calGoogleId || !row.connectionId) return

  const accessToken = await tokenDaConexao(accountId, row.connectionId)
  if (!accessToken) return

  if (op === 'delete') {
    if (row.googleEventId) await deleteGoogleEvent(accessToken, row.calGoogleId, row.googleEventId)
    return
  }

  const settings = await getAccountSettings(accountId)
  const tz = settings.businessTimezone || 'America/Sao_Paulo'
  const body = toGoogleBody(row as PushRow, tz)

  // 🩺 01/10 (pedido de uma clínica): o paciente vai junto — bloco com nome e
  // telefone no fim da DESCRIÇÃO (ver event-patient.ts); o título vai como foi
  // digitado. Só na conta que optou (googlePatientInfo) e nunca em reunião com
  // convidados. O bloco NÃO é gravado na descrição do CRM: ele volta sozinho
  // pelo import, e reaplicar sobre o que voltou não duplica.
  //
  // Sem paciente (desligado, conta sem a opção, reunião), o bloco antigo SAI.
  // E na edição a descrição vai SEMPRE, '' quando o CRM está vazio: o Google
  // espelha o CRM. Mandar nada deixava no Google o bloco do paciente desligado —
  // e o import religava esse mesmo paciente pelo telefone do bloco.
  try {
    const levar = levarPacienteAoGoogle({
      ligadoNaConta: settings.googlePatientInfo,
      op,
      convidados: opts.attendees,
      meet: opts.meet,
      evento: { location: row.location, description: row.description },
    })
    const paciente = levar ? await pacienteDoEvento(accountId, row.contactId) : null
    const descricao = descricaoParaGoogle(row.description, paciente)
    body.description = op === 'update' ? descricao : descricao || undefined
  } catch (err) {
    // Na dúvida, não mexe: a descrição vai como estava (vazia = o Google fica como está).
    console.error('[google-sync] paciente do evento falhou (descrição vai como estava):', err)
  }

  if (op === 'update' && row.googleEventId) {
    try {
      await patchGoogleEvent(accessToken, row.calGoogleId, row.googleEventId, body)
    } catch (err) {
      // Evento não existe mais no Google (404) → recria e regrava o id.
      if (String(err).includes('(404)')) {
        const recreated = await insertGoogleEvent(accessToken, row.calGoogleId, body)
        await db
          .update(calendarEvents)
          .set({ googleEventId: recreated.id, updatedAt: sql`now()` })
          .where(eq(calendarEvents.id, eventId))
      } else {
        throw err
      }
    }
    return
  }

  // create (ou update de um evento que ainda não existe no Google)
  if (op === 'create') {
    const emails = [...new Set((opts.attendees ?? []).map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))]
    if (emails.length) body.attendees = emails.map((email) => ({ email }))
    if (opts.meet) {
      body.conferenceData = {
        createRequest: { requestId: `fluxia-${eventId}`, conferenceSolutionKey: { type: 'hangoutsMeet' } },
      }
    }
  }
  const created = await insertGoogleEvent(accessToken, row.calGoogleId, body)
  await db
    .update(calendarEvents)
    .set({
      googleEventId: created.id,
      source: 'google',
      // O link da sala vira o "local" da reunião (quem abre na Agenda do CRM
      // já vê onde entrar) — sem apagar um local que já existia.
      ...(created.hangoutLink && !row.location ? { location: created.hangoutLink } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(calendarEvents.id, eventId))
  return { hangoutLink: created.hangoutLink }
}
