// ============================================================
// Marcador "até onde a última resposta da IA viu" — por conversa, no Redis.
//
// O guard anti-eco do auto-reply precisa responder UMA pergunta: "existe
// mensagem do cliente que NENHUMA resposta da IA cobriu?". Olhar só quem
// falou por último não resolve os dois lados:
//   - Debora (01/09): endereço chegou DURANTE a geração → resposta em voo
//     não viu → mas como a última msg passou a ser da IA, a rechecagem era
//     engolida e o endereço morria.
//   - Rose (01/09): "brindes?" chegou com o job ativo, mas ANTES da leitura
//     do histórico (as tools rodam primeiro) → a resposta em voo cobriu →
//     e a rechecagem, liberada por "job ativo", repetiu a pergunta.
// "Job ativo" não é o critério certo. O critério certo é o INSTANTE em que
// a geração leu o histórico: tudo que chegou antes está coberto, o que
// chegou depois não. É isso que este marcador guarda, gravado só depois de
// a resposta SAIR de verdade.
//
// Fail-open: Redis fora → `undefined` e o guard cai na regra antiga. Nunca
// lança. Worker-reachable (sem 'server-only').
// ============================================================

import { Redis, type RedisOptions } from 'ioredis'

import { bullConnection } from '@/lib/queue/connection'

const TTL_SECONDS = 48 * 3600
const key = (conversationId: string) => `ai:covered:${conversationId}`

let client: Redis | null | undefined

function redis(): Redis | null {
  if (client !== undefined) return client
  try {
    client = new Redis({
      ...(bullConnection() as RedisOptions),
      // Falha RÁPIDA quando o Redis não responde — o guard tem fallback.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
    client.on('error', () => {
      /* fail-open: os erros viram undefined/no-op nas chamadas */
    })
  } catch {
    client = null
  }
  return client
}

/**
 * Instante até o qual a última resposta da IA cobriu a conversa.
 *   Date       → há marca
 *   null       → Redis ok, mas nenhuma resposta marcou ainda
 *   undefined  → Redis indisponível (fail-open)
 */
export async function getCoveredUntil(
  conversationId: string,
): Promise<Date | null | undefined> {
  const r = redis()
  if (!r) return undefined
  try {
    const v = await r.get(key(conversationId))
    return v ? new Date(v) : null
  } catch {
    return undefined
  }
}

/** Grava a marca — chamar SÓ depois de a resposta ter saído. Nunca lança. */
export async function setCoveredUntil(
  conversationId: string,
  at: Date,
): Promise<void> {
  const r = redis()
  if (!r) return
  try {
    await r.set(key(conversationId), at.toISOString(), 'EX', TTL_SECONDS)
  } catch {
    /* fail-open */
  }
}
