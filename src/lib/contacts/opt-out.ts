// ============================================================
// Opt-out / "não perturbe" (anti-ban).
//
// Quando alguém pede pra não receber mais (responde SAIR/PARAR num disparo, ou
// toca "não quero mais" no oficial), marcamos o contato com `opted_out=true`.
// Disparos e agendadas PULAM esses contatos (atendente ainda responde 1:1).
//
// No WAHA (não-oficial) não há botão clicável → o opt-out é por PALAVRA-CHAVE.
// A detecção só afeta envios em massa/agendados, então um falso-positivo é de
// baixo dano (o atendente pode desbloquear).
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, contacts } from '@/db'

/** Reply id do botão "não quero mais" no canal oficial (Meta). */
export const OPT_OUT_BUTTON_REPLY_ID = 'optout_stop'
/** Reply id do botão "continuar recebendo" (só confirma; não faz nada). */
export const OPT_OUT_KEEP_REPLY_ID = 'optout_keep'

/** Palavras-chave de descadastro (mensagens curtas). Sem acento, minúsculas. */
const OPT_OUT_KEYWORDS = [
  'sair',
  'parar',
  'pare',
  'stop',
  'descadastrar',
  'cancelar inscricao',
  'sair da lista',
  'nao quero receber',
  'nao quero mais',
  'nao receber',
  'parar de receber',
  'remover da lista',
  'unsubscribe',
]

/** Minúsculas + sem acento + espaços colapsados. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * true se a mensagem/toque é um pedido de descadastro. Casa o botão do oficial
 * (replyId) OU uma palavra-chave em mensagem CURTA (≤ 30 chars) pra não pegar
 * "sair" no meio de uma frase longa ("vou sair de casa mais tarde").
 */
export function matchesOptOut(
  text: string | null | undefined,
  replyId?: string | null,
): boolean {
  if (replyId && replyId === OPT_OUT_BUTTON_REPLY_ID) return true
  const t = normalize(text ?? '')
  if (!t || t.length > 30) return false
  return OPT_OUT_KEYWORDS.some(
    (k) => t === k || new RegExp(`(^|\\s)${k}(\\s|$)`).test(t),
  )
}

/** Linha de descadastro anexada às mensagens de texto (WAHA). */
export const OPT_OUT_LINE = 'Se não quiser mais receber, responda SAIR.'

/** Anexa a linha de opt-out ao corpo, se ainda não estiver lá. */
export function appendOptOutLine(body: string): string {
  const b = (body ?? '').trimEnd()
  if (normalize(b).includes('responda sair')) return b
  return b ? `${b}\n\n_${OPT_OUT_LINE}_` : `_${OPT_OUT_LINE}_`
}

/** Marca o contato como "não perturbe" (idempotente). Devolve true se MUDOU
 *  (era subscrito e virou opt-out) — o chamador usa pra avisar a equipe 1x. */
export async function optOutContact(
  accountId: string,
  contactId: string,
  reason: string,
): Promise<boolean> {
  const res = await db
    .update(contacts)
    .set({
      optedOut: true,
      optedOutAt: new Date().toISOString(),
      optedOutReason: reason,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(contacts.id, contactId),
        eq(contacts.accountId, accountId),
        eq(contacts.optedOut, false),
      ),
    )
    .returning({ id: contacts.id })
  return res.length > 0
}

/** Desfaz o opt-out (atendente reativa o contato manualmente). */
export async function resubscribeContact(
  accountId: string,
  contactId: string,
): Promise<void> {
  await db
    .update(contacts)
    .set({
      optedOut: false,
      optedOutAt: null,
      optedOutReason: null,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
}

/** O contato está em "não perturbe"? (usado nos choke points de envio). */
export async function isContactOptedOut(contactId: string): Promise<boolean> {
  const row = await db
    .select({ optedOut: contacts.optedOut })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1)
  return row[0]?.optedOut === true
}
