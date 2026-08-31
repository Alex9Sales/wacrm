// ============================================================
// Importar MEMBROS de um grupo de WhatsApp como contatos etiquetados —
// miolo compartilhado entre a server action do inbox (group-actions.ts) e a
// rota pública POST /api/v1/conversations/:id/import-group (agente externo).
// Lê os participantes na sessão WAHA, cria os contatos (dedupe por telefone)
// e aplica a etiqueta "Grupo: <nome>" (ou a informada) — pronto pra disparo.
// Sem 'server-only' e sem revalidatePath (o chamador cuida da UI).
// ============================================================

import { and, eq, sql } from 'drizzle-orm'

import {
  db,
  contacts,
  conversations,
  tags,
  contactTags,
  monitoredGroups,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadChannelByAccount } from '@/lib/channels/channels'
import { findOrCreateContact } from '@/lib/api/v1/contacts'
import { wahaGroupParticipants } from '@/lib/channels/providers/waha'
import { groupJidDigits } from '@/lib/whatsapp/group'

export interface ImportGroupCoreResult {
  ok: boolean
  total: number
  contactsCreated: number
  tagged: number
  tagName: string
  error?: string
}

export async function importGroupMembersCore(
  accountId: string,
  userId: string,
  conversationId: string,
  tagNameOverride?: string,
): Promise<ImportGroupCoreResult> {
  const base: ImportGroupCoreResult = {
    ok: false,
    total: 0,
    contactsCreated: 0,
    tagged: 0,
    tagName: '',
  }

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
          eq(conversations.accountId, accountId),
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

  const ch = await loadChannelByAccount(accountId, conv.channelId)
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

  // Etiqueta "Grupo: <nome>" (ou a informada) — acha ou cria.
  const tagName = (tagNameOverride?.trim() || `Grupo: ${groupName}`).slice(0, 60)
  let tagId: string
  const existingTag = firstOrNull(
    await db
      .select({ id: tags.id })
      .from(tags)
      .where(
        and(
          eq(tags.accountId, accountId),
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
        .values({ userId, accountId, name: tagName })
        .returning({ id: tags.id }),
    )
    if (!t) return { ...base, error: 'Falha ao criar a etiqueta.', tagName }
    tagId = t.id
  }

  let contactsCreated = 0
  let tagged = 0
  for (const phone of phones) {
    try {
      const { id, created } = await findOrCreateContact(accountId, userId, {
        phone,
      })
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

  return { ok: true, total: phones.length, contactsCreated, tagged, tagName }
}
