// ============================================================
// 📸 Rajada de fotos: a IA descreve só as primeiras.
//
// 14/09 (GoLink): "NOS Redes" mandou 86 fotos de fachada em 1 minuto e
// "Rafael Montador" 37. A visão descreve cada imagem na hora em que chega,
// com a chave OpenAI da PRÓPRIA conta — 86 chamadas juntas estouraram o limite
// por minuto da conta OpenAI deles (429) e 81 fotos ficaram sem descrição. No
// mesmo minuto, tudo que usa a chave (ler comprovante da régua, IA) também
// levaria recusa. E álbum de fachada não precisa de descrição.
//
// Contador ATÔMICO no Redis por conversa: as fotos chegam juntas e cada uma só
// é gravada no banco DEPOIS da descrição, então contar pelo banco daria "0
// antes de mim" pra todas. Janela fixa de 60 s a partir da 1ª foto — mesmo
// script Lua do limitador de requisições (INCR + expira na 1ª).
//
// Fail-open: Redis fora → descreve como antes. Nunca lança. Worker-reachable
// (sem 'server-only' e sem next/server — o recebimento roda no worker também).
// ============================================================

import { Redis, type RedisOptions } from 'ioredis'

import { bullConnection } from '@/lib/queue/connection'

/** Quantas fotos da mesma conversa ganham descrição dentro da janela. */
export const IMAGE_BURST_LIMIT = 3
export const IMAGE_BURST_WINDOW_MS = 60_000

const WINDOW_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local pttl = redis.call('PTTL', KEYS[1])
if pttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  pttl = tonumber(ARGV[1])
end
return {count, pttl}
`

let client: Redis | null | undefined

function redis(): Redis | null {
  if (client !== undefined) return client
  try {
    client = new Redis({
      ...(bullConnection() as RedisOptions),
      // Falha RÁPIDA: sem Redis, a foto é descrita como antes.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
    client.on('error', () => {
      /* fail-open: os erros viram "descreve" nas chamadas */
    })
  } catch {
    client = null
  }
  return client
}

/**
 * Esta foto ganha descrição? Conta a foto na rajada da conversa e responde
 * true para as `IMAGE_BURST_LIMIT` primeiras da janela. Redis indisponível →
 * true (fail-open). Nunca lança.
 */
export async function shouldDescribeImage(conversationId: string): Promise<{ describe: boolean; position: number | null }> {
  const r = redis()
  if (!r) return { describe: true, position: null }
  try {
    const res = (await r.eval(WINDOW_LUA, 1, `vision:burst:${conversationId}`, String(IMAGE_BURST_WINDOW_MS))) as [number, number]
    const position = Number(res[0])
    return { describe: position <= IMAGE_BURST_LIMIT, position }
  } catch {
    return { describe: true, position: null }
  }
}

/** Só para testes: esquece o cliente (o mock troca a cada arquivo). */
export function __resetImageBurstForTests(): void {
  client = undefined
}
