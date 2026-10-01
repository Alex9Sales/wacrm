// ============================================================
// Google Calendar — sync (import Google → CRM) + refresh de token.
// v1: importa eventos das agendas do Google conectadas. O outbound
// (CRM → Google) entra na etapa seguinte.
// ============================================================

import { and, eq, isNull, sql } from 'drizzle-orm'
import { db, calendarConnections, calendars, calendarEvents, contacts } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { phoneFromDescription, phoneKey } from './event-contact'
import { descricaoParaGoogle, levarPacienteAoGoogle, type PacienteDoEvento } from './event-patient'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { zonedIso } from '@/lib/assistant/rules'
import { getAccountSettings } from '@/lib/settings/account-settings'
import {
  refreshAccessToken,
  listGoogleEvents,
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
function mapTimes(ev: GoogleEvent, tz: string): { startsAt: string; endsAt: string; allDay: boolean } | null {
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
    for (const cal of cals) {
      if (!cal.googleCalendarId) continue
      // showDeleted: o apagado precisa CHEGAR aqui pra liberar o horário.
      const events = await listGoogleEvents(accessToken, cal.googleCalendarId, timeMin, timeMax, {
        showDeleted: true,
      })
      for (const ev of events) {
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
            .select({ id: calendarEvents.id })
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
          location: ev.location ?? null,
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
          await db.update(calendarEvents).set({ ...values, updatedAt: sql`now()` }).where(eq(calendarEvents.id, existing.id))
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
