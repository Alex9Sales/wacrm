// ============================================================
// 📊 Métricas de cadência — "qual dá mais resultado e onde ela para".
//
// Pedido do Rafael (28/09). Nada aqui precisou de migração: `cadence_events`
// já guardava tudo, e ninguém lia. O que faltava era ler o funil POR DEGRAU:
// quantos receberam cada toque, quantos responderam NELE, quantos seguiram.
//
// O primeiro relatório já apontou o que ninguém enxergava: na "Exocad V1",
// 16 das 19 respostas vieram do 1º degrau, e os degraus 4 e 5 somaram 108
// envios sem UMA resposta. Métrica de cadência que não diz "pare aqui" não
// serve pra nada — por isso `readFunnel` devolve a leitura junto dos números.
//
// ⚠️ "Concluída" não quer dizer que rodou: `completed` com
// `data.reason = 'nenhum degrau aplicável…'` é inscrição que NUNCA enviou
// nada (faltou canal ou campo). Contar isso como concluída infla o
// denominador e esconde configuração quebrada — aqui ela sai separada.
// ============================================================

import { and, eq, sql } from 'drizzle-orm'

import { db, cadenceEvents, cadenceEnrollments, cadenceSteps } from '@/db'

/** Um degrau da cadência com o que aconteceu nele. */
export interface StepMetric {
  /** 1-based, como o operador conta na tela. */
  degree: number
  /** Texto (ou modelo) que saiu — liga o número à mensagem que o produziu. */
  label: string
  sent: number
  replied: number
  /** Seguiu adiante: recebeu o degrau seguinte. */
  advanced: number
  /** Respostas ÷ enviadas neste degrau. 0 quando nada saiu. */
  replyRate: number
}

export interface CadenceFunnel {
  cadenceId: string
  name: string
  enrolled: number
  replied: number
  /** Percorreu todos os degraus sem responder. */
  finishedSilent: number
  running: number
  /** Nunca enviou nada: faltou canal ou campo no contato. */
  neverRan: number
  steps: StepMetric[]
  reading: FunnelReading | null
}

/** A frase que a tela mostra antes dos números, com a ação que ela sugere. */
export interface FunnelReading {
  kind: 'front_loaded' | 'dead_tail' | 'no_replies' | 'too_early'
  headline: string
  detail: string
  /** Degrau a partir do qual nada mais responde (1-based). */
  cutFrom?: number
}

/** Divide sem estourar em 0 — cadência nova tem degrau com zero envio. */
function rate(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0
}

/**
 * Lê o funil e diz o que fazer. Puro de propósito: é a regra de negócio da
 * tela, e regra que decide corte de mensagem merece teste.
 *
 * Ordem importa: "nunca respondeu" vence "concentra no início", porque quem
 * não tem resposta nenhuma não tem o que concentrar.
 */
export function readFunnel(
  steps: StepMetric[],
  minSample = 20,
): FunnelReading | null {
  const withSends = steps.filter((s) => s.sent > 0)
  if (withSends.length === 0) return null
  const totalSent = withSends.reduce((a, s) => a + s.sent, 0)
  const totalReplies = withSends.reduce((a, s) => a + s.replied, 0)

  // Amostra pequena não sustenta decisão: dizer "corte o degrau 4" com 6
  // envios seria palpite com cara de dado.
  if (totalSent < minSample) {
    return {
      kind: 'too_early',
      headline: 'Ainda é cedo para concluir.',
      detail: `Foram ${totalSent} ${totalSent === 1 ? 'mensagem' : 'mensagens'} até agora — pouco para dizer qual degrau funciona. Os números já aparecem abaixo, degrau a degrau.`,
    }
  }

  if (totalReplies === 0) {
    return {
      kind: 'no_replies',
      headline: `Nenhuma resposta em ${totalSent} mensagens.`,
      detail:
        'Nenhum degrau desta cadência trouxe resposta. Antes de mandar mais gente, vale revisar o texto do primeiro toque — é ele que decide se a conversa começa.',
    }
  }

  // Cauda morta: a partir de onde ninguém mais responde, e quanto isso custou.
  let cutFrom: number | null = null
  for (let i = withSends.length - 1; i >= 0; i -= 1) {
    if (withSends[i].replied > 0) break
    cutFrom = withSends[i].degree
  }
  if (cutFrom !== null) {
    const tail = withSends.filter((s) => s.degree >= (cutFrom as number))
    const wasted = tail.reduce((a, s) => a + s.sent, 0)
    const keepUntil = (cutFrom as number) - 1
    return {
      kind: 'dead_tail',
      headline:
        tail.length === 1
          ? `O ${cutFrom}º degrau não trouxe nenhuma resposta.`
          : `Do ${cutFrom}º degrau em diante, ninguém respondeu.`,
      detail: `São ${wasted} ${wasted === 1 ? 'mensagem enviada' : 'mensagens enviadas'} sem uma única resposta. Encerrar a cadência no ${keepUntil}º degrau pouparia esses envios — e o desgaste do número — sem perder nenhuma conversa.`,
      cutFrom,
    }
  }

  // Concentração no primeiro toque: o caso mais comum, e o mais acionável.
  const first = withSends[0]
  const share = rate(first.replied, totalReplies)
  if (share >= 0.6 && withSends.length > 1) {
    return {
      kind: 'front_loaded',
      headline: `A primeira mensagem faz ${Math.round(share * 100)}% do trabalho.`,
      detail: `${first.replied} das ${totalReplies} respostas vieram do primeiro toque. Os degraus seguintes ainda trazem conversa, mas é no texto de entrada que vale mexer primeiro.`,
    }
  }
  return null
}

/**
 * O funil de UMA cadência, direto dos eventos.
 *
 * As respostas por degrau usam o `step_position` do próprio evento `paused`
 * e, quando ele não existe (eventos anteriores a 28/09), caem no último
 * `step_sent` da inscrição — assim o histórico continua legível em vez de
 * aparecer como zero.
 */
export async function getCadenceFunnel(
  accountId: string,
  cadenceId: string,
): Promise<CadenceFunnel | null> {
  const head = (
    await db.execute(sql`
      SELECT c.id, c.name,
             count(DISTINCT e.id) AS enrolled,
             count(DISTINCT e.id) FILTER (
               WHERE EXISTS (SELECT 1 FROM cadence_events pe
                              WHERE pe.enrollment_id = e.id AND pe.type = 'paused')
             ) AS replied,
             count(DISTINCT e.id) FILTER (WHERE e.status = 'done')    AS finished,
             count(DISTINCT e.id) FILTER (WHERE e.status = 'active')  AS running,
             count(DISTINCT e.id) FILTER (
               WHERE EXISTS (
                 SELECT 1 FROM cadence_events ne
                  WHERE ne.enrollment_id = e.id
                    AND ne.type = 'completed'
                    AND ne.data->>'reason' ILIKE '%nenhum degrau aplic%'
               )
             ) AS never_ran
        FROM cadences c
        LEFT JOIN cadence_enrollments e ON e.cadence_id = c.id
       WHERE c.id = ${cadenceId} AND c.account_id = ${accountId}
       GROUP BY c.id, c.name
    `)
  ).rows[0] as
    | {
        id: string
        name: string
        enrolled: string
        replied: string
        finished: string
        running: string
        never_ran: string
      }
    | undefined
  if (!head) return null

  const steps = await db
    .select({
      position: cadenceSteps.position,
      body: cadenceSteps.body,
      templateName: cadenceSteps.templateName,
    })
    .from(cadenceSteps)
    .where(
      and(eq(cadenceSteps.accountId, accountId), eq(cadenceSteps.cadenceId, cadenceId)),
    )
    .orderBy(cadenceSteps.position)

  const sentRows = (
    await db.execute(sql`
      SELECT step_position AS pos, count(DISTINCT enrollment_id) AS n
        FROM cadence_events
       WHERE account_id = ${accountId} AND cadence_id = ${cadenceId}
         AND type = 'step_sent' AND step_position IS NOT NULL
       GROUP BY step_position
    `)
  ).rows as { pos: number; n: string }[]

  const replyRows = (
    await db.execute(sql`
      WITH primeira AS (
        SELECT DISTINCT ON (p.enrollment_id)
               p.enrollment_id, p.step_position, p.created_at
          FROM cadence_events p
         WHERE p.account_id = ${accountId} AND p.cadence_id = ${cadenceId}
           AND p.type = 'paused'
         ORDER BY p.enrollment_id, p.created_at
      )
      SELECT COALESCE(
               f.step_position,
               (SELECT s.step_position FROM cadence_events s
                 WHERE s.enrollment_id = f.enrollment_id
                   AND s.type = 'step_sent' AND s.step_position IS NOT NULL
                   AND s.created_at <= f.created_at
                 ORDER BY s.created_at DESC LIMIT 1)
             ) AS pos,
             count(*) AS n
        FROM primeira f
       GROUP BY 1
    `)
  ).rows as { pos: number | null; n: string }[]

  const sentBy = new Map(sentRows.map((r) => [Number(r.pos), Number(r.n)]))
  const replyBy = new Map(
    replyRows
      .filter((r) => r.pos !== null)
      .map((r) => [Number(r.pos), Number(r.n)]),
  )

  const list: StepMetric[] = steps.map((s, i) => {
    const sent = sentBy.get(s.position) ?? 0
    const replied = replyBy.get(s.position) ?? 0
    const next = steps[i + 1]
    const advanced = next ? (sentBy.get(next.position) ?? 0) : 0
    const raw = (s.body ?? '').trim()
    return {
      degree: i + 1,
      label: raw
        ? raw.length > 120
          ? `${raw.slice(0, 120)}…`
          : raw
        : s.templateName
          ? `modelo: ${s.templateName}`
          : '(sem texto)',
      sent,
      replied,
      advanced,
      replyRate: rate(replied, sent),
    }
  })

  return {
    cadenceId: head.id,
    name: head.name,
    enrolled: Number(head.enrolled),
    replied: Number(head.replied),
    finishedSilent: Number(head.finished) - Number(head.never_ran),
    running: Number(head.running),
    neverRan: Number(head.never_ran),
    steps: list,
    reading: readFunnel(list),
  }
}

/** Uma linha por cadência para a lista — o "qual dá mais resultado". */
export interface CadenceOverviewRow {
  id: string
  name: string
  active: boolean
  enrolled: number
  replied: number
  running: number
  replyRate: number
  /** Degraus que trouxeram ao menos uma resposta (1-based). */
  repliedAt: number[]
  stepCount: number
}

export async function getCadenceOverview(
  accountId: string,
): Promise<CadenceOverviewRow[]> {
  const rows = (
    await db.execute(sql`
      SELECT c.id, c.name, c.active,
             (SELECT count(*) FROM cadence_steps st
               WHERE st.cadence_id = c.id) AS step_count,
             count(DISTINCT e.id) AS enrolled,
             count(DISTINCT e.id) FILTER (
               WHERE EXISTS (SELECT 1 FROM cadence_events pe
                              WHERE pe.enrollment_id = e.id AND pe.type = 'paused')
             ) AS replied,
             count(DISTINCT e.id) FILTER (WHERE e.status = 'active') AS running,
             COALESCE(
               (SELECT array_agg(DISTINCT pos ORDER BY pos)
                  FROM (
                    SELECT COALESCE(
                             f.step_position,
                             (SELECT s.step_position FROM cadence_events s
                               WHERE s.enrollment_id = f.enrollment_id
                                 AND s.type = 'step_sent' AND s.step_position IS NOT NULL
                                 AND s.created_at <= f.created_at
                               ORDER BY s.created_at DESC LIMIT 1)
                           ) AS pos
                      FROM (
                        SELECT DISTINCT ON (p.enrollment_id)
                               p.enrollment_id, p.step_position, p.created_at
                          FROM cadence_events p
                         WHERE p.cadence_id = c.id AND p.type = 'paused'
                         ORDER BY p.enrollment_id, p.created_at
                      ) f
                  ) q
                 WHERE pos IS NOT NULL),
               ARRAY[]::int[]
             ) AS replied_at
        FROM cadences c
        LEFT JOIN cadence_enrollments e ON e.cadence_id = c.id
       WHERE c.account_id = ${accountId}
       GROUP BY c.id, c.name, c.active
       ORDER BY count(DISTINCT e.id) DESC
    `)
  ).rows as {
    id: string
    name: string
    active: boolean
    step_count: string
    enrolled: string
    replied: string
    running: string
    replied_at: number[] | null
  }[]

  return rows.map((r) => {
    const enrolled = Number(r.enrolled)
    const replied = Number(r.replied)
    return {
      id: r.id,
      name: r.name,
      active: r.active,
      enrolled,
      replied,
      running: Number(r.running),
      replyRate: rate(replied, enrolled),
      // O evento guarda a posição do degrau (0-based); a tela conta a partir de 1.
      repliedAt: (r.replied_at ?? []).map((p) => Number(p) + 1),
      stepCount: Number(r.step_count),
    }
  })
}
