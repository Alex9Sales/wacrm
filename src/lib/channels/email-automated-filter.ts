// ============================================================
// 🤖 Filtro de e-mail automático — decide com o banco. Worker-safe (sem
// 'server-only'): gmail-poll (worker) e o webhook de e-mail (web) chamam.
//
// Regras em email-automated.ts. Aqui ficam as exceções que evitam perder
// cliente (revisão 15/09) — o e-mail entra mesmo parecendo robô quando o
// remetente (ou o Reply-To) é alguém que a conta conhece:
//   - e-mail cadastrado num contato (contacts.email);
//   - e-mail de cliente numa cobrança do Asaas (a régua manda pra esse e-mail
//     sem gravar no contato);
//   - contato criado por e-mail com quem a equipe JÁ falou (tem envio nosso) —
//     os contatos falsos de 15/09 nunca receberam nada, então seguem fora;
//   - mesmo domínio de empresa de um desses e-mails (noreply@devedor.com.br
//     mandando o comprovante), fora webmail público e o domínio do canal.
// Todo e-mail ignorado fica registrado no canal (contador + últimos 20) pra
// equipe ver o que ficou de fora.
//
// Na dúvida (banco fora), deixa entrar — perder e-mail é pior que um contato
// a mais.
// ============================================================

import { eq, sql } from 'drizzle-orm'

import { db, channels } from '@/db'
import type { ChannelCtx } from '@/lib/channels/provider'

import {
  automatedSenderReason,
  domainOf,
  ignoresAutomatedEmail,
  PUBLIC_EMAIL_DOMAINS,
  type EmailHeader,
} from './email-automated'

const MAX_RECENT = 20

async function isKnownSender(accountId: string, addresses: string[], domain: string | null): Promise<boolean> {
  const list = Array.from(new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean)))
  if (!list.length) return false
  const inList = sql.join(list.map((a) => sql`${a}`), sql`, `)
  const byAddress = sql`
    EXISTS (SELECT 1 FROM "contacts" ct WHERE ct."account_id" = ${accountId} AND lower(trim(ct."email")) IN (${inList}))
    OR EXISTS (
      SELECT 1 FROM "asaas_charges" ac, unnest(string_to_array(lower(ac."email"), ',')) AS e(addr)
      WHERE ac."account_id" = ${accountId} AND trim(e.addr) IN (${inList})
    )
    OR EXISTS (
      SELECT 1 FROM "contacts" ct
      JOIN "conversations" cv ON cv."contact_id" = ct."id"
      JOIN "messages" m ON m."conversation_id" = cv."id"
      WHERE ct."account_id" = ${accountId} AND lower(ct."external_id") IN (${inList})
        AND m."sender_type" IN ('agent', 'bot') AND m."is_internal" = false
    )`
  const byDomain = domain
    ? sql`
      OR EXISTS (SELECT 1 FROM "contacts" ct WHERE ct."account_id" = ${accountId} AND split_part(lower(trim(ct."email")), '@', 2) = ${domain})
      OR EXISTS (
        SELECT 1 FROM "asaas_charges" ac, unnest(string_to_array(lower(ac."email"), ',')) AS e(addr)
        WHERE ac."account_id" = ${accountId} AND split_part(trim(e.addr), '@', 2) = ${domain}
      )`
    : sql``
  const res = await db.execute(sql`SELECT (${byAddress} ${byDomain}) AS known`)
  return (res.rows[0] as { known?: boolean } | undefined)?.known === true
}

/** Contador + últimos 20 ignorados no provider_meta (merge jsonb; best-effort). */
async function recordIgnored(channelId: string, from: string, reason: string): Promise<void> {
  const entry = JSON.stringify({ from, reason, at: new Date().toISOString() })
  try {
    await db
      .update(channels)
      .set({
        providerMeta: sql`coalesce(${channels.providerMeta}, '{}'::jsonb) || jsonb_build_object(
          'ignoredAutomatedCount', coalesce((${channels.providerMeta}->>'ignoredAutomatedCount')::int, 0) + 1,
          'ignoredAutomated', (
            SELECT coalesce(jsonb_agg(x.e ORDER BY x.i), '[]'::jsonb)
            FROM jsonb_array_elements(
              jsonb_build_array(${entry}::jsonb) ||
              CASE WHEN jsonb_typeof(${channels.providerMeta}->'ignoredAutomated') = 'array'
                THEN ${channels.providerMeta}->'ignoredAutomated' ELSE '[]'::jsonb END
            ) WITH ORDINALITY AS x(e, i)
            WHERE x.i <= ${MAX_RECENT}
          )
        )`,
      })
      .where(eq(channels.id, channelId))
  } catch (err) {
    console.error('[email-filter] registrar ignorado falhou canal=%s:', channelId, err)
  }
}

/** Motivo pra ignorar este e-mail, ou null (entra normal). Nunca lança. */
export async function shouldIgnoreAutomatedEmail(
  ch: Pick<ChannelCtx, 'id' | 'accountId' | 'providerMeta'>,
  email: { from: string; replyTo?: string | null; headers?: readonly EmailHeader[] },
): Promise<string | null> {
  if (!ignoresAutomatedEmail(ch.providerMeta)) return null
  const channelAddress = typeof ch.providerMeta.address === 'string' ? ch.providerMeta.address : null
  const from = email.from.trim().toLowerCase()
  const reason = automatedSenderReason({ from, replyTo: email.replyTo, headers: email.headers, channelAddress })
  if (!reason) return null

  const fromDomain = domainOf(from)
  const channelDomain = domainOf(channelAddress)
  const companyDomain =
    fromDomain && !PUBLIC_EMAIL_DOMAINS.has(fromDomain) && fromDomain !== channelDomain ? fromDomain : null
  try {
    if (await isKnownSender(ch.accountId, [from, email.replyTo ?? ''], companyDomain)) return null
  } catch (err) {
    console.error('[email-filter] consulta de remetente conhecido falhou canal=%s — deixando entrar:', ch.id, err)
    return null
  }
  console.info('[email-filter] e-mail automático ignorado canal=%s de=%s motivo=%s', ch.id, from, reason)
  await recordIgnored(ch.id, from, reason)
  return reason
}
