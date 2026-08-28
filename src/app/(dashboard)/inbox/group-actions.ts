'use server'

// ============================================================
// Importar os MEMBROS de um grupo de WhatsApp como contatos (com etiqueta
// "Grupo: <nome>"), pra depois disparar 1:1 pra essa etiqueta em Disparos.
// Pedido do Rafael. Só WAHA (a engine expõe os participantes). Telefone de quem
// tem privacidade / nunca postou pode não vir — esses são pulados.
// ============================================================

import { and, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import {
  db,
  conversations,
  contacts,
  tags,
  contactTags,
  monitoredGroups,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireRole } from '@/lib/auth/account'
import { loadChannelByAccount } from '@/lib/channels/channels'
import { findOrCreateContact } from '@/lib/api/v1/contacts'
import { wahaGroupParticipants } from '@/lib/channels/providers/waha'
import { groupJidDigits } from '@/lib/whatsapp/group'

export interface ImportGroupResult {
  ok: boolean
  /** Participantes com telefone lidos da engine. */
  total: number
  /** Contatos novos criados. */
  contactsCreated: number
  /** Contatos que ganharam a etiqueta do grupo. */
  tagged: number
  tagName: string
  error?: string
}

export async function importGroupMembers(
  conversationId: string,
): Promise<ImportGroupResult> {
  const base: ImportGroupResult = {
    ok: false,
    total: 0,
    contactsCreated: 0,
    tagged: 0,
    tagName: '',
  }
  try {
    const ctx = await requireRole('agent')

    const conv = firstOrNull(
      await db
        .select({
          contactId: conversations.contactId,
          channelId: conversations.channelId,
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.accountId, ctx.accountId),
          ),
        )
        .limit(1),
    )
    if (!conv?.contactId || !conv.channelId)
      return { ...base, error: 'Conversa não encontrada.' }

    const groupContact = firstOrNull(
      await db
        .select({
          phone: contacts.phone,
          name: contacts.name,
          isGroup: contacts.isGroup,
          externalId: contacts.externalId,
        })
        .from(contacts)
        .where(eq(contacts.id, conv.contactId))
        .limit(1),
    )
    if (!groupContact?.isGroup)
      return { ...base, error: 'Essa conversa não é um grupo.' }

    // JID canônico (@g.us) do grupo — casa por dígitos com os grupos monitorados.
    const wantedDigits = groupJidDigits(
      groupContact.externalId || groupContact.phone,
    )
    const monitored = (
      await db
        .select({
          groupJid: monitoredGroups.groupJid,
          groupName: monitoredGroups.groupName,
        })
        .from(monitoredGroups)
        .where(eq(monitoredGroups.channelId, conv.channelId))
    ).find((r) => groupJidDigits(r.groupJid) === wantedDigits)

    const groupJid = monitored?.groupJid || groupContact.externalId || ''
    if (!groupJid) return { ...base, error: 'Não achei o grupo monitorado.' }
    const groupName = monitored?.groupName || groupContact.name || 'Grupo'

    const ch = await loadChannelByAccount(ctx.accountId, conv.channelId)
    if (!ch || ch.provider !== 'waha')
      return {
        ...base,
        error: 'Importar membros só funciona em canal WhatsApp (WAHA).',
      }

    const phones = await wahaGroupParticipants(ch, groupJid)
    if (phones.length === 0)
      return {
        ...base,
        error:
          'Não consegui ler os participantes (privacidade do grupo ou números não visíveis).',
      }

    // Etiqueta "Grupo: <nome>" — acha ou cria.
    const tagName = `Grupo: ${groupName}`.slice(0, 60)
    let tagId: string
    const existingTag = firstOrNull(
      await db
        .select({ id: tags.id })
        .from(tags)
        .where(
          and(
            eq(tags.accountId, ctx.accountId),
            sql`lower(${tags.name}) = lower(${tagName})`,
          ),
        )
        .limit(1),
    )
    if (existingTag) {
      tagId = existingTag.id
    } else {
      const t = firstOrNull(
        await db
          .insert(tags)
          .values({ userId: ctx.userId, accountId: ctx.accountId, name: tagName })
          .returning({ id: tags.id }),
      )
      if (!t) return { ...base, error: 'Falha ao criar a etiqueta.', tagName }
      tagId = t.id
    }

    let contactsCreated = 0
    let tagged = 0
    for (const phone of phones) {
      try {
        const { id, created } = await findOrCreateContact(
          ctx.accountId,
          ctx.userId,
          { phone },
        )
        if (created) contactsCreated++
        await db
          .insert(contactTags)
          .values({ contactId: id, tagId })
          .onConflictDoNothing({
            target: [contactTags.contactId, contactTags.tagId],
          })
        tagged++
      } catch {
        /* pula quem não resolve (número inválido/privacidade) */
      }
    }

    revalidatePath('/contacts')
    return { ok: true, total: phones.length, contactsCreated, tagged, tagName }
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : 'Falha ao importar membros.',
    }
  }
}
