// ============================================================
// Eco interno — "essa mensagem do cliente foi o PRÓPRIO CRM que mandou?"
//
// Caso 08/09 (conta Fluxia): o Sócio IA sai do canal WAHA "Alex Sales" (o
// celular do Alex) pro número oficial da Fluxia — que é OUTRO canal da mesma
// conta, com IA ligada. O resumo entra no canal oficial como mensagem
// recebida de "Alex Sanabria" e o agente de vendas responde ao resumo como
// se fosse um lead ("A Fluxia centraliza o atendimento…"). O mesmo desenho
// vira loop de duas IAs conversando sozinhas entre contas: resposta da IA A
// chega no canal da IA B, que responde, que chega na A…
//
// Duas fontes, qualquer uma basta:
//   1. Marcador no Redis gravado por quem ENVIA aviso do sistema (Sócio IA,
//      Avisos do dono) ANTES do envio — exato e independe da ordem em que os
//      webhooks chegam.
//   2. Banco: o telefone do "cliente" é o número de um canal WhatsApp do CRM
//      (de QUALQUER conta) E esse canal mandou um texto idêntico, como `bot`,
//      nos últimos 15 minutos. Pega resposta de IA chegando noutra IA.
//      Só `bot` de propósito: o que um humano digita no celular também
//      entra como saída do canal (sender_type 'agent'), e do outro lado
//      isso É gente de verdade — o Alex testa o agente oficial pelo próprio
//      celular, que é canal da conta.
//
// Fail-open em tudo: Redis/banco fora → "não é eco" e a IA segue a regra
// normal. Worker-reachable (sem 'server-only').
// ============================================================

import { Redis, type RedisOptions } from 'ioredis'
import { and, eq, gt, inArray, sql } from 'drizzle-orm'

import { db, channels, conversations, messages } from '@/db'
import { bullConnection } from '@/lib/queue/connection'
import { normalizePhone, phonesMatch } from '@/lib/whatsapp/phone-utils'

import { MIN_TEXT_FOR_DB_MATCH, normalizeSelfText, selfMessageFingerprint } from './self-message-text'

const MARK_TTL_SECONDS = 30 * 60
const DB_WINDOW_MS = 15 * 60 * 1000
const WA_PROVIDERS = ['waha', 'meta', 'evolution', 'evogo']

const key = (text: string) => `ai:selfmsg:${selfMessageFingerprint(text)}`

let client: Redis | null | undefined

function redis(): Redis | null {
  if (client !== undefined) return client
  try {
    client = new Redis({
      ...(bullConnection() as RedisOptions),
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
    client.on('error', () => {
      /* fail-open */
    })
  } catch {
    client = null
  }
  return client
}

/**
 * Quem envia aviso do SISTEMA pra um telefone (Sócio IA, Avisos) chama isto
 * antes de mandar. Se o destino for um canal com IA, a IA reconhece o texto e
 * não responde. Nunca lança.
 */
export async function markSelfMessage(text: string): Promise<void> {
  const r = redis()
  if (!r || !normalizeSelfText(text)) return
  try {
    await r.set(key(text), '1', 'EX', MARK_TTL_SECONDS)
  } catch {
    /* fail-open */
  }
}

export type SelfMessageVerdict =
  | { echo: false }
  | { echo: true; source: 'marker' | 'channel'; channelName?: string }

/**
 * A última "mensagem do cliente" (telefone `contactPhone`, texto `text`) foi
 * gerada pelo próprio CRM? Ver cabeçalho do arquivo.
 */
export async function isSelfMessage(args: {
  contactPhone: string | null | undefined
  text: string
}): Promise<SelfMessageVerdict> {
  const text = normalizeSelfText(args.text)
  if (!text) return { echo: false }

  // 1. Marcador gravado por quem enviou.
  const r = redis()
  if (r) {
    try {
      if (await r.exists(key(text))) return { echo: true, source: 'marker' }
    } catch {
      /* fail-open → tenta o banco */
    }
  }

  // 2. Banco: remetente é um canal do CRM que mandou este texto como bot há pouco.
  if (text.length < MIN_TEXT_FOR_DB_MATCH) return { echo: false }
  const digits = normalizePhone(args.contactPhone ?? '')
  if (digits.length < 8) return { echo: false }
  try {
    const tail = digits.slice(-8)
    const candidates = await db
      .select({ id: channels.id, name: channels.name, phoneNumber: channels.phoneNumber })
      .from(channels)
      .where(
        and(
          inArray(channels.provider, WA_PROVIDERS),
          sql`regexp_replace(coalesce(${channels.phoneNumber}, ''), '\\D', '', 'g') LIKE ${'%' + tail}`,
        ),
      )
    const own = candidates.filter((c) => c.phoneNumber && phonesMatch(c.phoneNumber, digits))
    if (own.length === 0) return { echo: false }

    const since = new Date(Date.now() - DB_WINDOW_MS).toISOString()
    const hit = await db
      .select({ channelId: conversations.channelId })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          inArray(
            conversations.channelId,
            own.map((c) => c.id),
          ),
          gt(conversations.lastMessageAt, since),
          eq(messages.senderType, 'bot'),
          gt(messages.createdAt, since),
          sql`regexp_replace(btrim(coalesce(${messages.contentText}, '')), '\\s+', ' ', 'g') = ${text}`,
        ),
      )
      .limit(1)
    const row = hit[0]
    if (!row) return { echo: false }
    return {
      echo: true,
      source: 'channel',
      channelName: own.find((c) => c.id === row.channelId)?.name,
    }
  } catch {
    return { echo: false }
  }
}
