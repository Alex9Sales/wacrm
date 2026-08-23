// ============================================================
// Link Zap rastreado — detecção do ref (#F7K2) na mensagem inbound. O link
// wa.me/QR de um formulário pré-preenche "Olá! Quero mais informações. #F7K2";
// quando esse "Oi" chega, o lead vira card no funil com a ORIGEM EXATA (nome do
// form) via ingestLead (contato deduplicado por telefone + tarefa + rodízio).
// Chamado pelo inbound (webhook/worker) → SEM 'use server' e SEM 'server-only'.
// ============================================================

import { and, eq, sql } from 'drizzle-orm'

import { db, captureForms, contacts, deals } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { ingestLead } from '@/lib/leads/ingest'

// #ABC12 — 4 a 8 caracteres alfanuméricos após o '#'.
const REF_RE = /#([A-Z0-9]{4,8})\b/i

/** Charset sem ambiguidade (sem 0/O/1/I/L) pra refs novos gerados no app. */
const REF_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function randomWaRef(len = 5): string {
  let out = ''
  for (let i = 0; i < len; i++) {
    out += REF_CHARS[Math.floor(Math.random() * REF_CHARS.length)]
  }
  return out
}

/**
 * Detecta o ref na mensagem e, se for de um formulário ATIVO da conta, cria o
 * card com a origem exata. Guardas: contato com negócio ABERTO não duplica
 * card (o ref só vem no 1º "Oi" — reenvios são inofensivos). Best-effort;
 * nunca lança (o inbound não pode cair por causa disto).
 */
export async function handleCaptureWaRef(
  accountId: string,
  contactId: string,
  text: string,
): Promise<void> {
  try {
    const m = (text ?? '').match(REF_RE)
    if (!m) return
    const ref = m[1].toUpperCase()

    // Regex casou → agora sim vale a pena buscar o contato (telefone + nome).
    const contact = firstOrNull(
      await db
        .select({ id: contacts.id, phone: contacts.phone, name: contacts.name })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
        .limit(1),
    )
    if (!contact?.phone) return

    const form = firstOrNull(
      await db
        .select({
          id: captureForms.id,
          name: captureForms.name,
          origin: captureForms.origin,
          pipelineId: captureForms.pipelineId,
          stageId: captureForms.stageId,
          createdBy: captureForms.createdBy,
        })
        .from(captureForms)
        .where(
          and(
            eq(captureForms.accountId, accountId),
            eq(captureForms.active, true),
            sql`upper(${captureForms.waRef}) = ${ref}`,
          ),
        )
        .limit(1),
    )
    if (!form) return

    // Contato já com negócio aberto → não duplica o card.
    const open = firstOrNull(
      await db
        .select({ id: deals.id })
        .from(deals)
        .where(
          and(
            eq(deals.accountId, accountId),
            eq(deals.contactId, contact.id),
            eq(deals.status, 'open'),
          ),
        )
        .limit(1),
    )
    if (open) return

    const auditUser = form.createdBy
    if (!auditUser) return

    await ingestLead(accountId, auditUser, {
      rawPhone: contact.phone,
      name: contact.name,
      pipelineId: form.pipelineId,
      stageId: form.stageId,
      origin: form.origin || 'WhatsApp',
      source: `Link WhatsApp: ${form.name}`,
      fallbackNote: `Chegou pelo link/QR do WhatsApp (${form.name}).`,
      taskSuffix: 'link WhatsApp',
    })
    await db
      .update(captureForms)
      .set({ waLeads: sql`wa_leads + 1` })
      .where(eq(captureForms.id, form.id))
    console.log(
      `[capture wa-ref] lead do link zap (conta ${accountId}, form "${form.name}", ref #${ref})`,
    )
  } catch (err) {
    console.error('[capture wa-ref] falhou:', err)
  }
}
