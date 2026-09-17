// ============================================================
// 🧾 Fase 3 — o que a régua FAZ com a resposta do devedor.
//
// A IA lê a conversa e emite um marcador; aqui é onde ele vira consequência.
// Cinco situações, cinco comportamentos, nenhum deles silencioso.
//
// A regra que não se negocia: **a IA nunca dá baixa**. Comprovante faz a régua
// dormir e chama uma pessoa para conferir — quem declara pago é o Asaas, nunca
// uma conversa. Um "já paguei" mentiroso, ou um print de outra fatura, não pode
// apagar uma dívida.
//
// Sem 'server-only' — roda no worker (auto-resposta).
// ============================================================

import { and, eq, sql } from 'drizzle-orm'

import { db, asaasCharges, collectionsTouches, contacts, member } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { notifyUsers } from '@/lib/orchestration/actions'
import { getAccountSettings } from '@/lib/settings/account-settings'

import { changeChargeDueDateCore } from './due-date'
import { pauseByAi } from './pause'
import { claimPauseOutcome, loadOpenChargesWithSiblings, markReceiptApplied } from './reply-context'
import { ACORDO_PAUSE_REASON, CONTESTA_PAUSE_REASON, RECEIPT_SNOOZE_REASON, promiseSnoozeReason } from './reply-guard'
import { normalizeSettings } from './rules'

export type CollectionReplyKind = 'promessa' | 'comprovante' | 'contesta' | 'acordo'

export interface CollectionReplyInput {
  accountId: string
  contactId: string
  conversationId: string | null
  kind: CollectionReplyKind
  /** Data prometida (YYYY-MM-DD), só para 'promessa'. */
  date: string | null
}

export interface CollectionReplyResult {
  applied: boolean
  /** O que aconteceu, em português — vira nota interna na conversa. */
  note: string
}

/**
 * Um dia de tolerância depois da data prometida: quem disse "pago dia 30"
 * costuma pagar no fim do dia 30, e voltar a cobrar na manhã do dia 30 queima
 * a confiança que a promessa acabou de criar.
 */
const PROMISE_GRACE_DAYS = 1

/** Comprovante: dorme enquanto uma pessoa confere no Asaas. */
const RECEIPT_HOLD_DAYS = 3

/**
 * Opções de quem chama. O padrão é o comportamento de sempre — é o que a
 * "Registrar promessa" da tela usa. A IA (detector silencioso e marcador)
 * passa o que a trava decidiu (reply-guard.ts): 16/09, uma conversa sobre
 * recarga do Google Ads pausou a régua da Ultra Visão por "acordo".
 */
export interface CollectionReplyOptions {
  /** false = a promessa nunca mexe no vencimento do Asaas (não foi resposta direta à cobrança). */
  moveDueDate?: boolean
  /** false = acordo/contestação só avisam, sem pausar a régua. */
  pause?: boolean
  /** Promessa mais distante que isto é recusada (a IA passa 45; a tela fica no padrão de 365). */
  maxPromiseDays?: number
  /**
   * true = "uma parcela só" (para mover o vencimento) soma as parcelas dos
   * cadastros irmãos (mesmo cliente do Asaas). Só a IA passa: 16/09 (revisão),
   * a "Registrar promessa" da tela fica como era — conta só as do contato.
   */
  countSiblings?: boolean
}

export async function applyCollectionReply(input: CollectionReplyInput, opts: CollectionReplyOptions = {}): Promise<CollectionReplyResult> {
  // Só faz sentido se este contato REALMENTE tem cobrança em aberto. Sem isso,
  // um marcador alucinado numa conversa qualquer mexeria no estado da régua.
  const openCharges = await db
    .select({ id: asaasCharges.id })
    .from(asaasCharges)
    .where(and(eq(asaasCharges.accountId, input.accountId), eq(asaasCharges.contactId, input.contactId), eq(asaasCharges.open, true)))
    .limit(2)
  const open = openCharges[0]
  if (!open) return { applied: false, note: '' }

  const now = new Date()
  const nowIso = now.toISOString()

  switch (input.kind) {
    case 'promessa': {
      const until = promiseDeadline(input.date, now, opts.maxPromiseDays)
      if (!until) {
        // Sem data utilizável não inventamos uma: a régua segue no ritmo normal
        // e o time vê na nota que houve promessa vaga.
        return { applied: false, note: '🧾 O cliente falou em pagar, mas sem data que desse para calcular. A régua continua no ritmo normal.' }
      }
      await upsertTouch(input.accountId, input.contactId, {
        snoozeUntil: until.toISOString(),
        snoozeReason: promiseSnoozeReason(input.date!),
        touchCount: 0,
        updatedAt: nowIso,
      })
      // Lacuna 3 (07/09): com a configuração ligada e UMA parcela em aberto, a
      // promessa também move o vencimento no Asaas — senão o boleto fica com a
      // data velha e os juros do Asaas continuam contando enquanto a régua dorme.
      // 16/09: na IA, só com resposta DIRETA à cobrança (uma promessa lida
      // errado não escreve no Asaas) e contando as parcelas dos cadastros irmãos
      // — a Ultra Visão tem uma parcela em cada contato e "uma só" era mentira.
      let extra = ''
      try {
        const s = normalizeSettings((await getAccountSettings(input.accountId)).collections)
        if (s.promiseUpdatesDueDate && opts.moveDueDate !== false) {
          const onlyOne = opts.countSiblings
            ? openCharges.length === 1 && (await loadOpenChargesWithSiblings(input.accountId, input.contactId)).length === 1
            : openCharges.length === 1
          if (onlyOne) {
            const moved = await changeChargeDueDateCore({ accountId: input.accountId, chargeId: open.id, dueDate: input.date!.slice(0, 10), actor: 'pela IA (promessa do cliente)' })
            extra = moved.ok
              ? ` Vencimento no Asaas movido para ${br(moved.dueDate)}${moved.invoiceUrl ? ' (novo link gerado)' : ''}.`
              : ` Não deu para mover o vencimento no Asaas: ${moved.error}`
          } else {
            extra = ' Há mais de uma parcela em aberto — vencimento no Asaas não alterado (ninguém chuta qual).'
          }
        }
      } catch (err) {
        console.error('[cobranca] promessa → vencimento falhou:', err instanceof Error ? err.message : err)
      }
      return {
        applied: true,
        note: `🧾 Cliente prometeu pagar em ${br(input.date!)}. A régua dorme até lá (com 1 dia de tolerância) e volta sozinha se não entrar.${extra}`,
      }
    }

    case 'comprovante': {
      const until = new Date(now.getTime() + RECEIPT_HOLD_DAYS * 86_400_000)
      const untilIso = until.toISOString()
      // 16/09 (Rack 95): comprovante de 1 das 3 parcelas chegando depois de uma
      // promessa até 20/09 gravava 3 dias por cima e ANTECIPAVA a régua. O
      // adiamento só cresce; o motivo só troca se o prazo novo for maior.
      const kept = await db
        .insert(collectionsTouches)
        .values({ accountId: input.accountId, contactId: input.contactId, snoozeUntil: untilIso, snoozeReason: RECEIPT_SNOOZE_REASON, touchCount: 0, updatedAt: nowIso })
        .onConflictDoUpdate({
          target: [collectionsTouches.accountId, collectionsTouches.contactId],
          set: {
            snoozeUntil: sql`GREATEST(COALESCE(${collectionsTouches.snoozeUntil}, 'epoch'::timestamptz), ${untilIso}::timestamptz)`,
            snoozeReason: sql`CASE WHEN ${collectionsTouches.snoozeUntil} IS NULL OR ${collectionsTouches.snoozeUntil} < ${untilIso}::timestamptz THEN ${RECEIPT_SNOOZE_REASON} ELSE ${collectionsTouches.snoozeReason} END`,
            touchCount: 0,
            updatedAt: nowIso,
          },
        })
        .returning({ snoozeUntil: collectionsTouches.snoozeUntil })
      const keptUntil = kept[0]?.snoozeUntil ? new Date(kept[0].snoozeUntil) : null
      const finalUntil = keptUntil && !Number.isNaN(keptUntil.getTime()) ? keptUntil : until
      // O motivo pode ter ficado o da promessa (GREATEST acima): a trava de
      // comprovante repetido lê este registro, não o motivo (Rack 95, revisão).
      // Grava também até quando a régua parou: depois de um "Cobrar agora" o
      // registro não vale mais (revisão 2).
      await markReceiptApplied(input.accountId, input.contactId, nowIso, finalUntil.toISOString())
      const longer = finalUntil.getTime() > until.getTime() + 60_000
      await alertTeam(input, 'Comprovante recebido', 'O cliente mandou comprovante. Confira no Asaas e dê a baixa por lá — a IA não dá baixa em pagamento.')
      return {
        applied: true,
        note: longer
          ? `🧾 Cliente mandou comprovante. A cobrança **não** foi baixada: alguém precisa conferir no Asaas. A régua já estava parada até ${finalUntil.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} e continua assim.`
          : `🧾 Cliente mandou comprovante. A cobrança **não** foi baixada: alguém precisa conferir no Asaas. A régua para por ${RECEIPT_HOLD_DAYS} dias enquanto isso.`,
      }
    }

    case 'contesta': {
      if (opts.pause === false) {
        await alertTeam(input, 'Cliente contesta a cobrança', 'Ele diz que não deve, cancelou ou não reconhece a cobrança. A régua NÃO parou: confira a conversa.')
        return { applied: true, note: '🧾 Cliente contesta a cobrança. A régua NÃO parou — o time foi avisado para conferir.' }
      }
      // A IA pausa com origem 'ai' (sai sozinha quando ele quita) e nunca
      // passa por cima de pausa da equipe — ver pause-rules.ts.
      const r = await pauseByAi(input.accountId, input.contactId, CONTESTA_PAUSE_REASON, nowIso)
      // Pausa que não aconteceu (equipe já pausou / retomada recente): avisa
      // uma vez; a mesma rajada relida não repete nota nem aviso (revisão 2).
      if (r !== 'paused' && !(await claimPauseOutcome(input.accountId, input.contactId, 'contesta', r))) return { applied: false, note: '' }
      await alertTeam(input, 'Cliente contesta a cobrança', 'Ele diz que não deve, cancelou ou não reconhece a cobrança.')
      return {
        applied: true,
        note:
          r === 'paused'
            ? '🧾 Cliente contesta a cobrança. A régua parou nele e o time foi avisado — ninguém insiste antes de conferir.'
            : r === 'team_paused'
              ? '🧾 Cliente contesta a cobrança. A régua já estava parada pela equipe (mantida) e o time foi avisado.'
              : '🧾 Cliente contesta a cobrança. A régua NÃO foi parada: uma pessoa retomou a cobrança há pouco. O time foi avisado.',
      }
    }

    case 'acordo': {
      if (opts.pause === false) {
        await alertTeam(input, 'Cliente pediu acordo', 'Ele pediu desconto, parcelamento ou para pagar só uma parte. A régua NÃO parou: confira a conversa.')
        return { applied: true, note: '🧾 Cliente pediu acordo ou parcelamento. A régua NÃO parou — o time foi avisado para conferir.' }
      }
      const r = await pauseByAi(input.accountId, input.contactId, ACORDO_PAUSE_REASON, nowIso)
      if (r !== 'paused' && !(await claimPauseOutcome(input.accountId, input.contactId, 'acordo', r))) return { applied: false, note: '' }
      await alertTeam(input, 'Cliente pediu acordo', 'Ele pediu desconto, parcelamento ou para pagar só uma parte. A IA não negocia: a régua parou e a conversa é sua.')
      return {
        applied: true,
        note:
          r === 'paused'
            ? '🧾 Cliente pediu acordo ou parcelamento. A IA não negocia — a régua parou e o time foi avisado. Se ele quitar o que está vencido, a régua volta sozinha.'
            : r === 'team_paused'
              ? '🧾 Cliente pediu acordo ou parcelamento. A régua já estava parada pela equipe (mantida) e o time foi avisado.'
              : '🧾 Cliente pediu acordo ou parcelamento. A régua NÃO foi parada: uma pessoa retomou a cobrança há pouco. O time foi avisado.',
      }
    }

    default:
      return { applied: false, note: '' }
  }
}

/**
 * Fuso comercial brasileiro em horas (UTC−3). O prazo é calculado em UTC
 * explícito por causa disto: `new Date('2026-09-30T23:59:59')` é interpretado
 * no fuso da MÁQUINA, então a hora em que a régua acorda mudaria conforme o
 * container (o CI, em UTC, pegou isso). Aqui o resultado é o mesmo em qualquer
 * servidor.
 */
const BR_UTC_OFFSET_HOURS = 3

/**
 * Quando a régua pode voltar a cobrar: a virada do dia seguinte ao prazo de
 * tolerância, no horário do Brasil. "Pago dia 30" com 1 dia de tolerância =
 * dorme o dia 30 e o dia 1º inteiros, e acorda na madrugada do dia 2.
 *
 * Recusa data no passado (o modelo errou o ano) ou muito distante.
 * `maxDays` (só a IA passa, 45) conta até o DIA prometido (00:00 no Brasil) —
 * 16/09, "pago no vencimento" de parcela a vencer adiaria a vencida por
 * semanas. Sem `maxDays` (a tela) fica a regra de antes: até o fim da
 * tolerância, 365 dias.
 */
export function promiseDeadline(date: string | null, now = new Date(), maxDays?: number): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((date ?? '').slice(0, 10))
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]

  const until = new Date(Date.UTC(y, mo - 1, d + PROMISE_GRACE_DAYS + 1, BR_UTC_OFFSET_HOURS, 0, 0))
  if (Number.isNaN(until.getTime())) return null
  // Data que já passou: o modelo errou o ano ou o cliente falou de outra coisa.
  if (until.getTime() <= now.getTime()) return null
  if (maxDays != null) {
    const promisedDay = Date.UTC(y, mo - 1, d, BR_UTC_OFFSET_HOURS, 0, 0)
    return promisedDay - now.getTime() > maxDays * 86_400_000 ? null : until
  }
  // Mais de um ano à frente quase sempre é ano errado; não congelamos a régua
  // por 12 meses com base num palpite.
  if (until.getTime() - now.getTime() > 365 * 86_400_000) return null
  return until
}

const br = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/')

async function upsertTouch(
  accountId: string,
  contactId: string,
  set: Partial<{
    snoozeUntil: string | null
    snoozeReason: string | null
    paused: boolean
    pausedReason: string | null
    touchCount: number
    updatedAt: string
  }>,
): Promise<void> {
  await db
    .insert(collectionsTouches)
    .values({ accountId, contactId, ...set })
    .onConflictDoUpdate({ target: [collectionsTouches.accountId, collectionsTouches.contactId], set })
}

/** Avisa quem opera a conta. Cobrança que trava precisa de dono, não de log. */
async function alertTeam(input: CollectionReplyInput, title: string, body: string): Promise<void> {
  try {
    const c = firstOrNull(
      await db.select({ name: contacts.name, phone: contacts.phone }).from(contacts).where(eq(contacts.id, input.contactId)).limit(1),
    )
    const who = c?.name || c?.phone || 'Cliente'
    const admins = await db
      .select({ userId: member.userId })
      .from(member)
      .where(eq(member.organizationId, input.accountId))
    await notifyUsers({
      accountId: input.accountId,
      userIds: admins.map((a) => a.userId),
      type: 'agent_action',
      title: `${title} — ${who}`,
      body,
      contactId: input.contactId,
      conversationId: input.conversationId,
    })
  } catch (err) {
    // Falhar o aviso não pode desfazer a pausa que já foi gravada.
    console.error('[cobranca] aviso ao time falhou:', err instanceof Error ? err.message : err)
  }
}

/**
 * Resumo da dívida para o prompt — só é chamado quando o contato tem algo em
 * aberto, e é o que permite a IA falar de valores sem inventar nenhum.
 */
export async function openDebtForPrompt(accountId: string, contactId: string): Promise<string | null> {
  const rows = await db
    .select({ value: asaasCharges.value, dueDate: asaasCharges.dueDate })
    .from(asaasCharges)
    .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.contactId, contactId), eq(asaasCharges.open, true)))
  if (!rows.length) return null

  const total = rows.reduce((sum, r) => sum + Number(r.value ?? 0), 0)
  const lines = rows.map(
    (r) => `- ${Number(r.value ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}, venceu em ${r.dueDate ? br(r.dueDate) : 'data não informada'}`,
  )
  const totalLine =
    rows.length > 1 ? `\nTotal: ${total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}` : ''
  return lines.join('\n') + totalLine
}
