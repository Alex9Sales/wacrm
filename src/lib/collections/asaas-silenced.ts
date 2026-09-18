// ============================================================
// 🔕 Quando o CRM calou o Asaas — o rastro que o aviso de cobrança nova lê.
//
// Por que existe (revisão 17/09 do aviso de cobrança nova, GoLink): em 15/09 o
// João criou Ômega Gás, Caçamba Exemplo, Beatriz Teste e Numerus no painel
// do Asaas e mandou os links à mão do celular — o aviso do CRM nunca disparou.
// Consertada a leitura, sobrou a pergunta que decide entre "dois avisos" e
// "nenhum aviso": o Asaas já estava calado para esse cliente quando a cobrança
// nasceu? O Asaas só devolve o `notificationDisabled` de AGORA e a data de
// criação só com o dia. Então quem cala guarda o instante e, logo depois de
// calar, a lista das cobranças do cliente que já existiam.
//
// Por que a lista é tirada DEPOIS de calar, e não antes: a cobrança que nasce
// nos segundos entre o PUT e a listagem entra na lista e conta como "o Asaas
// avisou" — no máximo um aviso a menos. Tirada antes, a que nascesse entre a
// listagem e o PUT ficava de fora e o CRM mandava o link que o Asaas já tinha
// mandado. Dois avisos é pior que um. E sem ninguém calado (a assinatura ativa
// recusa todo dia) não há listagem nenhuma.
//
// Quem cala e grava: a varredura (sync.ts), o botão "desligar avisos do Asaas"
// (cobrancas/actions.ts) e o complemento de cadastro na emissão (emit.ts).
//
// Redis com validade de 35 dias (sem migração): maior que qualquer janela do
// aviso (2 dias de envio; 3 semanas na conta que só cobra às segundas). Nunca
// lança. Redis fora na leitura = "não sei" — o aviso decide pelas chaves do
// Asaas, o caminho conservador. Sem 'server-only': o worker importa.
// ============================================================

import { Redis, type RedisOptions } from 'ioredis'
import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { listPaymentsCreatedSince, type AsaasCredential } from '@/lib/asaas/collections'
import { bullConnection } from '@/lib/queue/connection'

import { addDaysYmd, type SilencedRecord } from './new-charge-rules'

export const SILENCED_TTL_MS = 35 * 86_400_000

export const silencedKey = (connectionId: string, customerId: string) => `cobranca:calado:${connectionId}:${customerId}`

let client: Redis | null | undefined

function redis(): Redis | null {
  if (client !== undefined) return client
  try {
    client = new Redis({
      ...(bullConnection() as RedisOptions),
      maxRetriesPerRequest: 1,
      // Mesmo motivo do gmail-auth-backoff: o 1º comando espera a conexão;
      // Redis fora → recusa em 2 s, sem travar a varredura.
      enableOfflineQueue: true,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
    })
    client.on('error', () => {
      /* nunca derruba a varredura */
    })
  } catch {
    client = null
  }
  return client
}

/** Só para testes: esquece o cliente (o mock troca a cada arquivo). */
export function __resetSilencedForTests(): void {
  client = undefined
}

export interface ChargesAtSilencing {
  /** Primeiro dia coberto pela listagem. */
  since: string
  /** Cobranças que já existiam, por cliente do Asaas. */
  byCustomer: Map<string, string[]>
}

/**
 * Logo DEPOIS de calar: as cobranças criadas desde ONTEM (data UTC menos 1 —
 * cobre o dia de hoje no horário de Brasília mesmo depois das 21h), por
 * cliente. Uma listagem (só GET; 20 a 40 cobranças por dia na GoLink, longe do
 * teto de 5.000). null = não deu para listar; o aviso cai na regra do dia.
 */
export async function listChargesAtSilencing(
  cred: AsaasCredential,
  opts: { customer?: string; timeoutMs?: number; now?: Date } = {},
): Promise<ChargesAtSilencing | null> {
  const since = addDaysYmd((opts.now ?? new Date()).toISOString().slice(0, 10), -1)
  try {
    const pays = await listPaymentsCreatedSince(cred, since, { customer: opts.customer, timeoutMs: opts.timeoutMs })
    const byCustomer = new Map<string, string[]>()
    for (const p of pays) {
      if (!p?.id || !p.customer) continue
      const ids = byCustomer.get(p.customer) ?? []
      ids.push(p.id)
      byCustomer.set(p.customer, ids)
    }
    return { since, byCustomer }
  } catch {
    return null
  }
}

/** Grava "o CRM calou estes clientes agora". Nunca lança. */
export async function recordSilenced(
  connectionId: string,
  customerIds: readonly string[],
  charges: ChargesAtSilencing | null,
  now: Date = new Date(),
): Promise<void> {
  const ids = [...new Set(customerIds.filter(Boolean))]
  if (!ids.length) return
  // Revisão 17/09: sem rastro, o aviso de cobrança nova lê "calado antes"
  // (silencedBeforeCharge) e manda o link sem olhar as chaves do Asaas — para
  // quem o Asaas avisou antes de a varredura calar, sai dobrado. A falha não
  // pode sumir em silêncio: fica no log com a conexão e os clientes, para saber
  // que o "antes" deles é chute.
  const semRastro = (quantos: number, motivo: string) => {
    const amostra = ids.slice(0, 5).join(', ') + (ids.length > 5 ? ', …' : '')
    console.warn(
      `[cobranca] rastro de avisos calados NÃO gravado para ${quantos} de ${ids.length} cliente(s) da conexão ${connectionId} (${amostra}): ${motivo} — o aviso de cobrança nova pode repetir o link que o Asaas já mandou a eles.`,
    )
  }
  try {
    const r = redis()
    if (!r) {
      semRastro(ids.length, 'Redis indisponível')
      return
    }
    const at = now.toISOString()
    const pipe = r.pipeline()
    for (const id of ids) {
      const rec: SilencedRecord = charges ? { at, beforeSince: charges.since, before: charges.byCustomer.get(id) ?? [] } : { at }
      pipe.set(silencedKey(connectionId, id), JSON.stringify(rec), 'PX', SILENCED_TTL_MS)
    }
    // O ioredis NÃO rejeita o exec quando um comando falha (Redis fora, tempo
    // esgotado): devolve [erro, resposta] por comando. Só o catch não via nada.
    const res = await pipe.exec()
    const falhas = (res ?? []).filter(([err]) => err)
    if (!res) semRastro(ids.length, 'o Redis não respondeu')
    else if (falhas.length) semRastro(falhas.length, falhas[0][0]?.message || 'erro do Redis')
  } catch (err) {
    semRastro(ids.length, err instanceof Error ? err.message : String(err))
  }
}

/** Registro gravado → SilencedRecord; lixo ou vazio → null. */
export function parseSilencedRecord(raw: string | null | undefined): SilencedRecord | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<SilencedRecord> | null
    if (!v || typeof v.at !== 'string' || Number.isNaN(Date.parse(v.at))) return null
    return {
      at: v.at,
      beforeSince: typeof v.beforeSince === 'string' ? v.beforeSince : null,
      before: Array.isArray(v.before) ? v.before.filter((x): x is string => typeof x === 'string') : null,
    }
  } catch {
    return null
  }
}

/**
 * Lê os registros de uma vez (MGET). Chave `${connectionId}|${customerId}`.
 * null = Redis indisponível (quem chama trata como "não sei").
 */
export async function loadSilenced(
  pairs: readonly { connectionId: string; customerId: string }[],
): Promise<Map<string, SilencedRecord | null> | null> {
  const out = new Map<string, SilencedRecord | null>()
  const unicos = [...new Map(pairs.map((p) => [`${p.connectionId}|${p.customerId}`, p])).values()]
  if (!unicos.length) return out
  try {
    const r = redis()
    if (!r) return null
    const vals = await r.mget(...unicos.map((p) => silencedKey(p.connectionId, p.customerId)))
    unicos.forEach((p, i) => out.set(`${p.connectionId}|${p.customerId}`, parseSilencedRecord(vals[i])))
    return out
  } catch {
    return null
  }
}

/**
 * Marca a primeira varredura completa DEPOIS de ligar "o CRM assume os avisos"
 * (`asaasNotificationsSweptAt`, piso do aviso de cobrança nova). Atômico no
 * banco, sem ler-e-regravar o JSON inteiro: a varredura roda no worker e não
 * pode apagar um "Salvar" da tela feito no mesmo segundo. Só grava se a opção
 * está ligada, se `atIso` é depois do clique e se ainda não há uma varredura
 * válida — a primeira vale; as seguintes não empurram o piso. Nunca lança.
 *
 * Se um "Salvar" concorrente sobrescrever o campo, o aviso espera a próxima
 * varredura — que a sincronização seguinte antecipa enquanto a conta espera
 * (`fullSweepReason`), sem a rotina de 20 h.
 */
export async function markAsaasNotificationsSwept(accountId: string, atIso: string): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE account_settings
      SET settings = jsonb_set(settings, '{collections,asaasNotificationsSweptAt}', to_jsonb(${atIso}::text), true),
          updated_at = now()
      WHERE account_id = ${accountId}::uuid
        AND jsonb_typeof(settings->'collections') = 'object'
        AND settings->'collections'->>'asaasNotificationsOff' = 'true'
        AND settings->'collections'->>'asaasNotificationsOffAt' IS NOT NULL
        AND ${atIso}::timestamptz >= (settings->'collections'->>'asaasNotificationsOffAt')::timestamptz
        AND (
          settings->'collections'->>'asaasNotificationsSweptAt' IS NULL
          OR (settings->'collections'->>'asaasNotificationsSweptAt')::timestamptz < (settings->'collections'->>'asaasNotificationsOffAt')::timestamptz
        )
    `)
  } catch (err) {
    console.warn('[cobranca] não deu para marcar a varredura de avisos:', err instanceof Error ? err.message : err)
  }
}
