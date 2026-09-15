// ============================================================
// Espera entre logins recusados do Gmail.
//
// 15/09 (GoLink, senha de app revogada): tentar a cada minuto são ~60 logins
// inválidos por hora, e o Google pode bloquear a conta. Depois de uma recusa o
// poll espera 30 min. Trocar a senha de app pela tela apaga a espera, e o
// canal volta a ser lido no próximo tick.
//
// Chave no Redis compartilhada entre worker (poll) e web (troca de senha).
// Fail-open: Redis fora → tenta como antes. Nunca lança. Sem 'server-only'
// (o worker importa).
// ============================================================

import { Redis, type RedisOptions } from 'ioredis'

import { bullConnection } from '@/lib/queue/connection'

export const GMAIL_AUTH_FAIL_BACKOFF_MS = 30 * 60_000

let client: Redis | null | undefined

function redis(): Redis | null {
  if (client !== undefined) return client
  try {
    client = new Redis({
      ...(bullConnection() as RedisOptions),
      maxRetriesPerRequest: 1,
      // O 1º comando de um cliente novo espera a conexão (com
      // enableOfflineQueue:false o ioredis RECUSA na hora: a 1ª troca de senha
      // depois de um deploy não apagava a espera). Redis fora → recusa em 2 s.
      enableOfflineQueue: true,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
    })
    client.on('error', () => {
      /* fail-open */
    })
  } catch {
    client = null
  }
  return client
}

export const gmailAuthFailKey = (channelId: string) => `gmail:authfail:${channelId}`

export async function inGmailAuthBackoff(channelId: string): Promise<boolean> {
  try {
    return (await redis()?.exists(gmailAuthFailKey(channelId))) === 1
  } catch {
    return false
  }
}

export async function markGmailAuthFailed(channelId: string): Promise<void> {
  try {
    await redis()?.set(gmailAuthFailKey(channelId), new Date().toISOString(), 'PX', GMAIL_AUTH_FAIL_BACKOFF_MS)
  } catch {
    /* fail-open */
  }
}

/** true = espera apagada (ou não havia); false = Redis não respondeu (o poll volta quando a espera vencer). */
export async function clearGmailAuthBackoff(channelId: string): Promise<boolean> {
  try {
    const r = redis()
    if (!r) return false
    await r.del(gmailAuthFailKey(channelId))
    return true
  } catch {
    return false
  }
}

/** Só para testes: esquece o cliente (o mock troca a cada arquivo). */
export function __resetGmailAuthBackoffForTests(): void {
  client = undefined
}
