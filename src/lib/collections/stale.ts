// ============================================================
// 🧾 Rascunho de cobrança só vale no DIA em que foi montado.
//
// A régua monta a mensagem com os números daquele momento ("vence hoje",
// "em 5 dias", "27 dias de atraso"). Se o pedido fica na fila de um dia pro
// outro (régua pausada, fim da janela, teto do dia), o texto envelhece: o
// "vence hoje" de ontem sairia hoje já vencido, e o lembrete "em 5 dias"
// sairia com 4. Caso João/GoLink (10/09): 47 pedidos montados às 9h ficaram
// parados o dia inteiro com a régua desligada.
//
// Regra: pedido de cobrança (automático OU aprovado) criado em outro dia, no
// fuso da conta, EXPIRA com o motivo escrito. A rodada seguinte da régua monta
// de novo com os números do dia — e o lembrete expirado não conta como "já
// lembrado" (reminders.ts ignora expired/failed). Ninguém recebe texto velho.
//
// Sem 'server-only' — roda no worker (engine e sender).
// ============================================================
import { and, eq, inArray, sql } from 'drizzle-orm'

import { db, agentActionRequests } from '@/db'

export const STALE_DRAFT_REASON =
  'Ficou na fila de um dia pro outro — os números envelheceram. A régua monta de novo na próxima rodada, com os valores de hoje.'

/** 'YYYY-MM-DD' do instante no fuso da conta. Fuso inválido → UTC. */
export function localDayKey(tz: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
  } catch {
    return at.toISOString().slice(0, 10)
  }
}

/**
 * Expira os pedidos de cobrança ainda na fila (pending/queued) que NÃO foram
 * montados hoje (dia local da conta). Devolve quantos expiraram. Nunca lança.
 */
export async function expireStaleCollectionDrafts(accountId: string, tz: string, now: Date = new Date()): Promise<number> {
  const today = localDayKey(tz, now)
  try {
    const rows = await db
      .update(agentActionRequests)
      .set({ status: 'expired', error: STALE_DRAFT_REASON, resolvedAt: now.toISOString() })
      .where(
        and(
          eq(agentActionRequests.accountId, accountId),
          eq(agentActionRequests.actionType, 'collect_charges'),
          inArray(agentActionRequests.status, ['pending', 'queued']),
          sql`to_char(${agentActionRequests.createdAt} AT TIME ZONE ${tz}, 'YYYY-MM-DD') <> ${today}`,
        ),
      )
      .returning({ id: agentActionRequests.id })
    if (rows.length) console.log(`[cobranca] ${rows.length} rascunho(s) de outro dia expirados (conta ${accountId.slice(0, 8)})`)
    return rows.length
  } catch (err) {
    console.error('[cobranca] expirar rascunhos velhos falhou:', err instanceof Error ? err.message : err)
    return 0
  }
}
