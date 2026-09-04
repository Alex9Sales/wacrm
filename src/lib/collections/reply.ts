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

import { and, eq } from 'drizzle-orm'

import { db, asaasCharges, collectionsTouches, contacts, member } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { notifyUsers } from '@/lib/orchestration/actions'

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

export async function applyCollectionReply(input: CollectionReplyInput): Promise<CollectionReplyResult> {
  // Só faz sentido se este contato REALMENTE tem cobrança em aberto. Sem isso,
  // um marcador alucinado numa conversa qualquer mexeria no estado da régua.
  const open = firstOrNull(
    await db
      .select({ id: asaasCharges.id })
      .from(asaasCharges)
      .where(and(eq(asaasCharges.accountId, input.accountId), eq(asaasCharges.contactId, input.contactId), eq(asaasCharges.open, true)))
      .limit(1),
  )
  if (!open) return { applied: false, note: '' }

  const now = new Date()
  const nowIso = now.toISOString()

  switch (input.kind) {
    case 'promessa': {
      const until = promiseDeadline(input.date, now)
      if (!until) {
        // Sem data utilizável não inventamos uma: a régua segue no ritmo normal
        // e o time vê na nota que houve promessa vaga.
        return { applied: false, note: '🧾 O cliente falou em pagar, mas sem data que desse para calcular. A régua continua no ritmo normal.' }
      }
      await upsertTouch(input.accountId, input.contactId, {
        snoozeUntil: until.toISOString(),
        snoozeReason: `Cliente prometeu pagar em ${br(input.date!)}`,
        touchCount: 0,
        updatedAt: nowIso,
      })
      return {
        applied: true,
        note: `🧾 Cliente prometeu pagar em ${br(input.date!)}. A régua dorme até lá (com 1 dia de tolerância) e volta sozinha se não entrar.`,
      }
    }

    case 'comprovante': {
      const until = new Date(now.getTime() + RECEIPT_HOLD_DAYS * 86_400_000)
      await upsertTouch(input.accountId, input.contactId, {
        snoozeUntil: until.toISOString(),
        snoozeReason: 'Cliente mandou comprovante — aguardando conferência',
        touchCount: 0,
        updatedAt: nowIso,
      })
      await alertTeam(input, 'Comprovante recebido', 'O cliente mandou comprovante. Confira no Asaas e dê a baixa por lá — a IA não dá baixa em pagamento.')
      return {
        applied: true,
        note: `🧾 Cliente mandou comprovante. A cobrança **não** foi baixada: alguém precisa conferir no Asaas. A régua para por ${RECEIPT_HOLD_DAYS} dias enquanto isso.`,
      }
    }

    case 'contesta': {
      await upsertTouch(input.accountId, input.contactId, {
        paused: true,
        pausedReason: 'Cliente contesta a cobrança',
        updatedAt: nowIso,
      })
      await alertTeam(input, 'Cliente contesta a cobrança', 'Ele diz que não deve ou que já pagou. A régua parou nele até alguém verificar.')
      return { applied: true, note: '🧾 Cliente contesta a cobrança. A régua parou nele e o time foi avisado — ninguém insiste antes de conferir.' }
    }

    case 'acordo': {
      await upsertTouch(input.accountId, input.contactId, {
        paused: true,
        pausedReason: 'Cliente pediu acordo/parcelamento',
        updatedAt: nowIso,
      })
      await alertTeam(input, 'Cliente pediu acordo', 'Ele pediu desconto, prazo ou parcelamento. A IA não negocia: a régua parou e a conversa é sua.')
      return { applied: true, note: '🧾 Cliente pediu acordo ou parcelamento. A IA não negocia — a régua parou e o time foi avisado.' }
    }

    default:
      return { applied: false, note: '' }
  }
}

/** Data prometida + tolerância. Recusa data no passado ou absurdamente longe. */
export function promiseDeadline(date: string | null, now = new Date()): Date | null {
  if (!date) return null
  const d = new Date(`${date.slice(0, 10)}T23:59:59`)
  if (Number.isNaN(d.getTime())) return null

  const until = new Date(d.getTime() + PROMISE_GRACE_DAYS * 86_400_000)
  // Data que já passou: o modelo errou o ano ou o cliente falou de outra coisa.
  if (until.getTime() <= now.getTime()) return null
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
