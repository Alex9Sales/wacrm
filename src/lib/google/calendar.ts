// ============================================================
// Google Calendar — helpers OAuth + REST (via fetch, sem googleapis).
// Credenciais vêm do ambiente (nunca do código): GOOGLE_CLIENT_ID /
// GOOGLE_CLIENT_SECRET. redirect_uri deriva de BETTER_AUTH_URL (ou
// GOOGLE_REDIRECT_URI) e TEM que bater com o registrado no Google Cloud.
// ============================================================

import crypto from 'crypto'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
const CAL_BASE = 'https://www.googleapis.com/calendar/v3'

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ')

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
}

export function redirectUri(): string {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI
  const base = (process.env.BETTER_AUTH_URL ?? '').replace(/\/$/, '')
  return `${base}/api/google/calendar/callback`
}

// --- state assinado (anti-tamper); a identidade vem da sessão no callback ---
function stateSecret(): string {
  return process.env.BETTER_AUTH_SECRET || process.env.ENCRYPTION_KEY || 'dev-state'
}
export function signState(): string {
  const nonce = crypto.randomBytes(8).toString('hex')
  const ts = Date.now().toString()
  const sig = crypto
    .createHmac('sha256', stateSecret())
    .update(`${nonce}.${ts}`)
    .digest('base64url')
  return `${nonce}.${ts}.${sig}`
}
export function verifyState(state: string | null): boolean {
  if (!state) return false
  const parts = state.split('.')
  if (parts.length !== 3) return false
  const [nonce, ts, sig] = parts
  const expected = crypto
    .createHmac('sha256', stateSecret())
    .update(`${nonce}.${ts}`)
    .digest('base64url')
  if (sig !== expected) return false
  // Válido por 15 min.
  return Date.now() - Number(ts) < 15 * 60_000
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  return `${AUTH_URL}?${params.toString()}`
}

export type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  token_type?: string
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) throw new Error(`Google token exchange falhou (${res.status}): ${await res.text()}`)
  return (await res.json()) as TokenResponse
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Google refresh falhou (${res.status}): ${await res.text()}`)
  return (await res.json()) as TokenResponse
}

export async function fetchUserEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return null
    const data = (await res.json()) as { email?: string }
    return data.email ?? null
  } catch {
    return null
  }
}

export type GoogleCalendarListItem = {
  id: string
  summary: string
  primary?: boolean
  backgroundColor?: string
}

export async function listCalendarList(
  accessToken: string,
): Promise<GoogleCalendarListItem[]> {
  const res = await fetch(`${CAL_BASE}/users/me/calendarList?minAccessRole=writer`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Google calendarList (${res.status}): ${await res.text()}`)
  const data = (await res.json()) as { items?: GoogleCalendarListItem[] }
  return data.items ?? []
}

export type GoogleEvent = {
  id: string
  status?: string
  summary?: string
  description?: string
  location?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  /** 'transparent' = "Mostrar como: Disponível" (não ocupa o horário). Ausente = ocupado. */
  transparency?: string
  /** Link do Google Meet, quando o evento tem videochamada. */
  hangoutLink?: string
}

/** Teto de páginas por agenda — trava de segurança contra loop de pageToken. */
const EVENTS_MAX_PAGES = 10

/**
 * Eventos de uma agenda na janela pedida.
 *
 * Duas coisas que a v1 não fazia e custavam caro pra IA:
 *  - `showDeleted`: sem isso, evento apagado no Google somem da resposta e a
 *    cópia daqui fica 'confirmed' pra sempre — a IA segue achando o horário
 *    ocupado. Com ele, o apagado volta com status 'cancelled' e o sync libera.
 *  - paginação: `maxResults` é teto POR PÁGINA. Uma agenda cheia passava de 250
 *    na janela e o resto sumia em silêncio — e o que some aqui vira reunião
 *    marcada em cima de compromisso.
 */
export async function listGoogleEvents(
  accessToken: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
  opts: { showDeleted?: boolean } = {},
): Promise<GoogleEvent[]> {
  const items: GoogleEvent[] = []
  let pageToken: string | undefined
  for (let page = 0; page < EVENTS_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
    })
    if (opts.showDeleted) params.set('showDeleted', 'true')
    if (pageToken) params.set('pageToken', pageToken)
    const res = await fetch(
      `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!res.ok) throw new Error(`Google events (${res.status}): ${await res.text()}`)
    const data = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string }
    items.push(...(data.items ?? []))
    if (!data.nextPageToken) return items
    pageToken = data.nextPageToken
  }
  console.warn(`[google sync] ${calendarId}: parei em ${EVENTS_MAX_PAGES} páginas de eventos`)
  return items
}

// --- escrita (CRM → Google) ---

export type GoogleEventBody = {
  summary: string
  description?: string
  location?: string
  start: { dateTime?: string; date?: string }
  end: { dateTime?: string; date?: string }
  /** Convidados (o Google manda o convite por e-mail com sendUpdates=all). */
  attendees?: { email: string }[]
  /** Pede uma sala do Google Meet (exige conferenceDataVersion=1). */
  conferenceData?: {
    createRequest: { requestId: string; conferenceSolutionKey: { type: 'hangoutsMeet' } }
  }
}

export async function insertGoogleEvent(
  accessToken: string,
  calendarId: string,
  body: GoogleEventBody,
): Promise<{ id: string; hangoutLink?: string }> {
  // Meet e convite só funcionam com estes parâmetros: sem conferenceDataVersion
  // o Google ignora o pedido de sala; sem sendUpdates o convidado não recebe o
  // e-mail (só aparece na agenda de quem criou).
  const params = new URLSearchParams()
  if (body.conferenceData) params.set('conferenceDataVersion', '1')
  if (body.attendees?.length) params.set('sendUpdates', 'all')
  const qs = params.toString()
  const res = await fetch(
    `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events${qs ? `?${qs}` : ''}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) throw new Error(`Google insert event (${res.status}): ${await res.text()}`)
  return (await res.json()) as { id: string; hangoutLink?: string }
}

export async function patchGoogleEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  body: GoogleEventBody,
): Promise<void> {
  const res = await fetch(
    `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) throw new Error(`Google patch event (${res.status}): ${await res.text()}`)
}

export async function deleteGoogleEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  const res = await fetch(
    `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
  )
  // 404/410 = já não existe no Google → tratamos como sucesso.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`Google delete event (${res.status}): ${await res.text()}`)
  }
}
