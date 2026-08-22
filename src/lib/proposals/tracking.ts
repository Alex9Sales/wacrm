// ============================================================
// Rastreio + aceite da proposta pública. Chamado pelas rotas /api/public/proposta
// (sem auth — a proposta é resolvida pelo id/token). Carimba a 1ª visualização e
// registra o aceite (nome + CPF/CNPJ + IP), notificando o vendedor e jogando na
// timeline do negócio. Sem 'use server' e sem 'server-only'.
// ============================================================

import { and, eq, isNull, sql } from 'drizzle-orm'

import { db, dealProposals, deals, dealEvents, notifications } from '@/db'
import { firstOrNull } from '@/db/helpers'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function dealFor(dealId: string, accountId: string) {
  return firstOrNull(
    await db
      .select({ assignedTo: deals.assignedTo, title: deals.title })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.accountId, accountId)))
      .limit(1),
  )
}

// Notifica o vendedor (dono do negócio). Reusa o tipo 'deal_transferred' (já
// deep-linka pro negócio via dealId; o CHECK de notifications.type não aceita
// tipos novos) — o título/corpo deixam claro que é sobre a proposta.
async function notifySeller(
  accountId: string,
  dealId: string,
  sellerUserId: string | null,
  title: string,
  body: string,
) {
  if (!sellerUserId) return
  try {
    await db.insert(notifications).values({
      accountId,
      userId: sellerUserId,
      type: 'deal_transferred',
      dealId,
      title,
      body,
    })
  } catch (err) {
    console.error('[proposal] notify failed:', err)
  }
}

/** Carimba a 1ª visualização (idempotente): notifica + timeline só na primeira. */
export async function markProposalViewed(proposalId: string): Promise<void> {
  if (!UUID_RE.test(proposalId)) return
  try {
    const updated = await db
      .update(dealProposals)
      .set({ viewedAt: sql`now()` })
      .where(
        and(eq(dealProposals.id, proposalId), isNull(dealProposals.viewedAt)),
      )
      .returning({
        accountId: dealProposals.accountId,
        dealId: dealProposals.dealId,
      })
    if (!updated.length) return // já visualizada (ou não existe)
    const { accountId, dealId } = updated[0]
    const d = await dealFor(dealId, accountId)
    await Promise.all([
      db.insert(dealEvents).values({
        accountId,
        actorUserId: null,
        dealId,
        type: 'note',
        data: { text: '👀 Proposta visualizada pelo cliente.' },
      }),
      notifySeller(
        accountId,
        dealId,
        d?.assignedTo ?? null,
        'Proposta visualizada 👀',
        d?.title
          ? `O cliente abriu a proposta de "${d.title}".`
          : 'O cliente abriu a proposta.',
      ),
    ])
  } catch (err) {
    console.error('[markProposalViewed]', err)
  }
}

/** Registra o aceite (idempotente): grava aceitante + IP, notifica + timeline. */
export async function acceptProposal(
  proposalId: string,
  input: { name: string; document?: string | null; ip?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  if (!UUID_RE.test(proposalId)) return { ok: false, error: 'Proposta inválida.' }
  const name = (input.name ?? '').trim()
  if (!name) return { ok: false, error: 'Informe seu nome para aceitar.' }
  const document = (input.document ?? '').trim() || null
  const ip = (input.ip ?? '').trim() || null
  try {
    const updated = await db
      .update(dealProposals)
      .set({
        acceptedAt: sql`now()`,
        acceptorName: name,
        acceptorDocument: document,
        acceptorIp: ip,
        viewedAt: sql`COALESCE(viewed_at, now())`,
      })
      .where(
        and(eq(dealProposals.id, proposalId), isNull(dealProposals.acceptedAt)),
      )
      .returning({
        accountId: dealProposals.accountId,
        dealId: dealProposals.dealId,
      })
    if (!updated.length) {
      // Ou não existe, ou já foi aceita antes (idempotente → ok).
      const exists = firstOrNull(
        await db
          .select({ id: dealProposals.id })
          .from(dealProposals)
          .where(eq(dealProposals.id, proposalId))
          .limit(1),
      )
      return exists ? { ok: true } : { ok: false, error: 'Proposta não encontrada.' }
    }
    const { accountId, dealId } = updated[0]
    const d = await dealFor(dealId, accountId)
    const docPart = document ? ` (${document})` : ''
    await Promise.all([
      db.insert(dealEvents).values({
        accountId,
        actorUserId: null,
        dealId,
        type: 'note',
        data: { text: `✅ Proposta ACEITA por ${name}${docPart}.` },
      }),
      notifySeller(
        accountId,
        dealId,
        d?.assignedTo ?? null,
        'Proposta aceita ✅',
        d?.title
          ? `${name} aceitou a proposta de "${d.title}".`
          : `${name} aceitou a proposta.`,
      ),
    ])
    return { ok: true }
  } catch (err) {
    console.error('[acceptProposal]', err)
    return { ok: false, error: 'Falha ao registrar o aceite.' }
  }
}
