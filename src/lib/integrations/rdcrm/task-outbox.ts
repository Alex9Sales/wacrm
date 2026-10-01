// ============================================================
// 📝 Fila de TAREFAS concluídas para o RD CRM (espelho).
//
// Cada toque de cadência (e, quando o dono ligar, cada follow-up) que a régua
// envia vira, no RD, uma tarefa JÁ CONCLUÍDA no negócio ligado ao card. Pedido
// da Zelo (29/09): o time trabalha no RD e via o lead "sem nenhuma tentativa"
// enquanto a régua já tinha mandado três mensagens — e ligava de novo, ou
// mandava o mesmo texto à mão.
//
// Por que FILA e não chamada direta: quem envia o toque (worker de agendamento)
// não pode esperar o RD nem cair por causa dele, e o card pode ainda não estar
// ligado a um negócio do RD (o espelho espera até 10 min o negócio que o RD
// Marketing cria). A fila `crm_task_outbox` (migração 0202) guarda o fato; o
// tick do espelho (`drainTaskOutbox`, em sync.ts) leva pro RD quando dá.
//
// Este arquivo é LEVE de propósito (só banco + funções puras): é importado pela
// cadência e pelo follow-up. Sem 'server-only' — roda no worker.
// ============================================================

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { canonName } from './mapping'
import { isRdRejection, rdActivityText, rid, type RdCrmClient, type RdTask } from './client'

export interface RdTaskInput {
  accountId: string
  /** Card local (deals.id). A tarefa vai para o negócio RD ligado a ele. */
  dealId: string
  /** Tarefa local (tasks.id), quando existe — trava contra duplicata. */
  taskId: string | null
  kind: 'whatsapp' | 'email'
  subject: string
  notes?: string | null
  doneAt: Date
}

/**
 * Enfileira a tarefa para o RD. Nunca lança; sem integração RD ligada na conta
 * não faz nada (o INSERT só acontece se a integração existe e está ligada —
 * conta sem espelho não acumula fila que ninguém vai ler).
 *
 * Duplicata: a mesma tarefa local (`taskId`) entra UMA vez (índice único
 * parcial + ON CONFLICT DO NOTHING) — um toque reprocessado não vira duas
 * tarefas no RD.
 */
export async function enqueueRdTask(input: RdTaskInput): Promise<void> {
  try {
    const subject = input.subject.trim().slice(0, 200)
    if (!subject) return
    const doneAt = Number.isFinite(input.doneAt?.getTime?.()) ? input.doneAt : new Date()
    const notes = input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null
    // Todo parâmetro com tipo explícito: no SELECT de um INSERT … SELECT o
    // Postgres não deduz o tipo pela coluna de destino e recusa a consulta
    // ("could not determine data type of parameter").
    await db.execute(sql`
      INSERT INTO crm_task_outbox (account_id, deal_id, task_id, kind, subject, notes, done_at)
      SELECT ${input.accountId}::uuid, ${input.dealId}::uuid, ${input.taskId}::uuid,
             ${input.kind}::text, ${subject}::text, ${notes}::text,
             ${doneAt.toISOString()}::timestamptz
      WHERE EXISTS (
        SELECT 1 FROM crm_integrations i
        WHERE i.account_id = ${input.accountId}::uuid
          AND i.provider = 'rdstation_crm'
          AND i.enabled
      )
        AND EXISTS (
          SELECT 1 FROM deals d
          WHERE d.id = ${input.dealId}::uuid AND d.account_id = ${input.accountId}::uuid
        )
      ON CONFLICT DO NOTHING
    `)
  } catch (err) {
    // Registro no RD é acessório: o toque já saiu e a tarefa local já existe.
    console.error('[rd-crm] tarefa não entrou na fila:', err instanceof Error ? err.message : err)
  }
}

// ------------------------------------------------------------
// Partes puras do envio (testáveis sem banco nem rede).
// ------------------------------------------------------------

/** Data ("YYYY-MM-DD") e hora ("HH:MM") de `at` no fuso da conta. */
export function rdTaskDateHour(at: Date, tz: string): { date: string; hour: string } {
  const parts = (zone: string) =>
    Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
        .formatToParts(at)
        .map((x) => [x.type, x.value]),
    )
  let p: Record<string, string>
  try {
    p = parts(tz || 'America/Sao_Paulo')
  } catch {
    p = parts('America/Sao_Paulo') // fuso inválido na config: o da casa
  }
  return { date: `${p.year}-${p.month}-${p.day}`, hour: `${p.hour}:${p.minute}` }
}

export interface RdTaskPush {
  rdDealId: string
  userId: string
  kind: 'whatsapp' | 'email'
  subject: string
  notes: string | null
  date: string
  hour: string
}

/**
 * Corpo do POST /tasks (especificação do RD — NÃO testado ao vivo, 01/10).
 * Assunto e notas sem acento: o RD grava acento torto nos textos que chegam
 * pela API (visto no /activities em 18/09; ver rdActivityText).
 */
export function buildRdTaskBody(t: RdTaskPush, opts: { done?: boolean } = {}): { task: Record<string, unknown> } {
  const notes = t.notes ? rdActivityText(t.notes).trim() : ''
  return {
    task: {
      deal_id: t.rdDealId,
      user_ids: [t.userId],
      subject: rdActivityText(t.subject).trim().slice(0, 200),
      type: t.kind,
      date: t.date,
      hour: t.hour,
      ...(notes ? { notes } : {}),
      ...(opts.done !== false ? { done: true } : {}),
    },
  }
}

/**
 * A tarefa que JÁ está no RD com o mesmo assunto, data e hora — um POST que
 * estourou o tempo pode ter criado a tarefa sem a resposta chegar; reenviar
 * duplicaria. Assunto comparado pelo texto que de fato foi enviado (sem
 * acento), data pelos 10 primeiros caracteres (o RD pode devolver com hora) e
 * hora pelos 5.
 */
export function findSameRdTask(
  tasks: RdTask[],
  want: { subject: string; date: string; hour: string },
): RdTask | null {
  const subject = canonName(rdActivityText(want.subject).trim().slice(0, 200))
  return (
    tasks.find(
      (t) =>
        canonName(t.subject) === subject &&
        (t.date ?? '').slice(0, 10) === want.date &&
        (t.hour ?? '').slice(0, 5) === want.hour,
    ) ?? null
  )
}

/**
 * Leva UMA tarefa pro RD, concluída. Devolve o id dela lá.
 *   1. já existe (tentativa anterior criou)? usa ela — e conclui, se não está;
 *   2. senão POST com done:true; o RD recusou (4xx)? tenta sem o `done`
 *      (campo que a especificação lista mas ninguém viu funcionar);
 *   3. resposta não diz done=true → PUT /tasks/:id {task:{done:true}}.
 * Lança no erro (quem chama conta a tentativa).
 */
export async function pushTaskToRd(
  api: Pick<RdCrmClient, 'listDealTasks' | 'createTask' | 'updateTask'>,
  t: RdTaskPush,
): Promise<{ id: string; reused: boolean }> {
  const existing = findSameRdTask(await api.listDealTasks(t.rdDealId), t)
  if (existing) {
    const id = rid(existing)
    if (!id) throw new Error('tarefa do RD sem id')
    if (existing.done !== true) await api.updateTask(id, { task: { done: true } })
    return { id, reused: true }
  }
  let created: RdTask
  try {
    created = await api.createTask(buildRdTaskBody(t))
  } catch (err) {
    if (!isRdRejection(err)) throw err
    created = await api.createTask(buildRdTaskBody(t, { done: false }))
  }
  const id = rid(created)
  if (!id) throw new Error('RD não devolveu o id da tarefa criada')
  if (created.done !== true) await api.updateTask(id, { task: { done: true } })
  return { id, reused: false }
}
